/* Claude Certification Study Trainer — vanilla JS, no build step. */

const LS_KEY = 'ccTrainerHistory_v1';
const LS_DOMAIN_KEY = 'ccTrainerDomainStats_v1';
const LS_LANG_KEY = 'ccTrainerLang_v1';

function loadLang() {
  const v = localStorage.getItem(LS_LANG_KEY);
  return v === 'ja' ? 'ja' : 'en';
}
function saveLang(lang) {
  localStorage.setItem(LS_LANG_KEY, lang);
}
function toggleLang() {
  saveLang(loadLang() === 'ja' ? 'en' : 'ja');
  render();
}
function langSwitcherHtml() {
  const lang = loadLang();
  return `<div class="lang-switch">
    <button class="ghost lang-btn ${lang === 'en' ? 'active' : ''}" onclick="if('${lang}'!=='en') toggleLang()">EN</button>
    <button class="ghost lang-btn ${lang === 'ja' ? 'active' : ''}" onclick="if('${lang}'!=='ja') toggleLang()">JA</button>
  </div>`;
}

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
  catch (e) { return {}; }
}
function saveHistory(h) {
  localStorage.setItem(LS_KEY, JSON.stringify(h));
}

/* Cumulative per-domain correct/total counts across every attempt, used to find weak domains. */
function loadDomainStats() {
  try { return JSON.parse(localStorage.getItem(LS_DOMAIN_KEY)) || {}; }
  catch (e) { return {}; }
}
function saveDomainStats(s) {
  localStorage.setItem(LS_DOMAIN_KEY, JSON.stringify(s));
}
function recordDomainStats(examId, byDomain) {
  const stats = loadDomainStats();
  stats[examId] = stats[examId] || {};
  Object.entries(byDomain).forEach(([domainId, d]) => {
    if (!d.total) return;
    const cur = stats[examId][domainId] || { correct: 0, total: 0 };
    cur.correct += d.correct;
    cur.total += d.total;
    stats[examId][domainId] = cur;
  });
  saveDomainStats(stats);
}
/* Domains sorted weakest-first (lowest accuracy), only counting domains with enough samples. */
function getWeakDomains(examId, minSamples) {
  const stats = (loadDomainStats()[examId]) || {};
  return Object.entries(stats)
    .filter(([id, d]) => d.total >= (minSamples || 1))
    .map(([id, d]) => ({ id, correct: d.correct, total: d.total, acc: d.correct / d.total }))
    .sort((a, b) => a.acc - b.acc);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const LETTERS = ['A', 'B', 'C', 'D'];

/* The Japanese explanation text references choice letters inline (e.g. "正解はB", "並列に
   分割する(A)のは..."). Those letters were authored against JA_TRANSLATIONS' original
   (unshuffled) choice order, so once the choices are reordered for display, every letter
   token in the prose has to be remapped to where that same option ended up. letterMap maps
   old letter -> new letter for a given shuffle `order` (order[k] = original index now at
   position k). */
function buildLetterMap(order) {
  const map = {};
  LETTERS.forEach((oldLetter, oldPos) => {
    map[oldLetter] = LETTERS[order.indexOf(oldPos)];
  });
  return map;
}
/* "正解は" is followed by one or more letters (e.g. "正解はB" or "正解はA・C") for multi-select
   questions; each letter in that run is remapped independently, same as the parenthetical refs. */
function remapJaLetters(text, map) {
  return text
    .replace(/正解は((?:[A-D][・、,]?)+)/g, (m, run) => '正解は' + run.replace(/[A-D]/g, l => map[l] || l))
    .replace(/([\(（])([A-D])([\)）])/g, (m, open, l, close) => open + (map[l] || l) + close);
}

/* Shuffle a question's choice order so the correct answer isn't always in the same position.
   The attached Japanese translation (if any) is reordered with the exact same permutation so
   its A/B/C/D list stays positionally aligned with the shuffled English choices above it, and
   its explanation text's inline letter references are remapped to match. Multi-select questions
   (q.answer is an array) get every correct index remapped through the same shuffle order. */
function shuffleChoices(q, examId) {
  const order = shuffle(q.choices.map((c, i) => i));
  const choices = order.map(i => q.choices[i]);
  const isMulti = Array.isArray(q.answer);
  const answer = isMulti
    ? q.answer.map(a => order.indexOf(a)).sort((a, b) => a - b)
    : order.indexOf(q.answer);
  const jaOrig = (examId && JA_TRANSLATIONS[examId] && JA_TRANSLATIONS[examId][q._idx]) || null;
  let ja = null;
  if (jaOrig) {
    const letterMap = buildLetterMap(order);
    ja = {
      q: jaOrig.q,
      choices: order.map(i => jaOrig.choices[i]),
      explain: remapJaLetters(jaOrig.explain, letterMap),
    };
  }
  return { ...q, choices, answer, ja };
}

/* Shared correctness check for both single-select (answer: number) and multi-select
   (answer: number[], "Select TWO" style) questions. */
function isAnswerCorrect(q, selected) {
  if (Array.isArray(q.answer)) {
    if (!Array.isArray(selected) || selected.length !== q.answer.length) return false;
    return q.answer.every(a => selected.includes(a));
  }
  return selected === q.answer;
}

/* Compute a weight-proportional per-domain question count for a target quiz length. */
function computeDomainAllocations(examId, count, byDomain) {
  const meta = EXAM_META[examId];
  const domains = meta.domains.filter(d => byDomain[d.id] && byDomain[d.id].length);
  const totalWeight = domains.reduce((s, d) => s + d.weight, 0);
  let allocations = domains.map(d => {
    const raw = (d.weight / totalWeight) * count;
    return { id: d.id, raw, base: Math.max(1, Math.floor(raw)) };
  });
  allocations.forEach(a => { a.base = Math.min(a.base, byDomain[a.id].length); });
  let sum = allocations.reduce((s, a) => s + a.base, 0);
  let diff = count - sum;
  let guard = 0;
  while (diff !== 0 && guard < 500) {
    guard++;
    if (diff > 0) {
      const candidates = allocations.filter(a => a.base < byDomain[a.id].length);
      if (!candidates.length) break;
      candidates.sort((a, b) => (b.raw - b.base) - (a.raw - a.base));
      candidates[0].base++;
      diff--;
    } else {
      const candidates = allocations.filter(a => a.base > 0);
      if (!candidates.length) break;
      candidates.sort((a, b) => (a.raw - a.base) - (b.raw - b.base));
      candidates[0].base--;
      diff++;
    }
  }
  return allocations;
}

/* Build a quiz question list sampled roughly proportional to domain weight. */
function buildQuizSet(examId, count) {
  const allQ = QUESTIONS[examId].map((q, idx) => ({ ...q, _idx: idx }));
  const byDomain = {};
  allQ.forEach(q => { (byDomain[q.domain] = byDomain[q.domain] || []).push(q); });

  if (count >= allQ.length) return shuffle(allQ).map(q => shuffleChoices(q, examId));

  const allocations = computeDomainAllocations(examId, count, byDomain);
  let picked = [];
  allocations.forEach(a => {
    picked = picked.concat(shuffle(byDomain[a.id]).slice(0, a.base));
  });
  return shuffle(picked).map(q => shuffleChoices(q, examId));
}

/* Rotating per-domain cursors so consecutive mock exams minimize repeats until the
   domain's pool is exhausted, at which point it reshuffles and wraps around. */
const mockCursors = {};
function nextFromDomainCursor(examId, domainId, n, pool) {
  mockCursors[examId] = mockCursors[examId] || {};
  let cursor = mockCursors[examId][domainId];
  if (!cursor) {
    cursor = { order: shuffle(pool), pos: 0 };
    mockCursors[examId][domainId] = cursor;
  }
  const result = [];
  for (let i = 0; i < n; i++) {
    if (cursor.pos >= cursor.order.length) {
      cursor.order = shuffle(pool);
      cursor.pos = 0;
    }
    result.push(cursor.order[cursor.pos]);
    cursor.pos++;
  }
  return result;
}

/* Build a full-length mock exam (matching the official item count) that rotates through
   the question bank so repeated mocks reuse as little as possible before wrapping. Domain
   allocations are always computed against the full bank (so weighting stays correct across
   all domains), but each domain's picks prefer that domain's scenario:true pool — the
   real-world "how would you use Claude here" questions — falling back to the general pool
   for any domain that doesn't have scenario questions yet. */
function buildMockSet(examId, count) {
  const allQ = QUESTIONS[examId].map((q, idx) => ({ ...q, _idx: idx }));
  const byDomain = {};
  allQ.forEach(q => { (byDomain[q.domain] = byDomain[q.domain] || []).push(q); });
  const scenarioByDomain = {};
  allQ.filter(q => q.scenario).forEach(q => { (scenarioByDomain[q.domain] = scenarioByDomain[q.domain] || []).push(q); });
  const allocations = computeDomainAllocations(examId, Math.min(count, allQ.length), byDomain);
  let picked = [];
  allocations.forEach(a => {
    const domainPool = (scenarioByDomain[a.id] && scenarioByDomain[a.id].length) ? scenarioByDomain[a.id] : byDomain[a.id];
    picked = picked.concat(nextFromDomainCursor(examId, a.id, a.base, domainPool));
  });
  return shuffle(picked).map(q => shuffleChoices(q, examId));
}

/* ---------------- State ---------------- */
let state = { route: 'home' };

function go(route, extra) {
  state = { route, ...extra };
  render();
  window.scrollTo(0, 0);
}

function renderOverview(examId) {
  const o = EXAM_OVERVIEW[examId];
  if (!o) return '';
  return `
    <details class="overview">
      <summary>試験概要を見る(対象者・受験資格・料金・再受験規定など)</summary>
      <div class="overview-body">
        <div class="ov-row"><div class="ov-label">対象者</div><div class="ov-val">${o.audience}</div></div>
        <div class="ov-row"><div class="ov-label">推奨経験</div><div class="ov-val">${o.recommended}</div></div>
        <div class="ov-row"><div class="ov-label">前提条件</div><div class="ov-val">${o.prerequisites}</div></div>
        <div class="ov-row"><div class="ov-label">出題形式</div><div class="ov-val">${o.format}</div></div>
        <div class="ov-row"><div class="ov-label">合格基準</div><div class="ov-val">${o.passing}</div></div>
        <div class="ov-row"><div class="ov-label">受験料</div><div class="ov-val">${o.fee}</div></div>
        <div class="ov-row"><div class="ov-label">有効期間</div><div class="ov-val">${o.validity}</div></div>
        <div class="ov-row"><div class="ov-label">再受験規定</div><div class="ov-val">${o.retake}</div></div>
        <div class="ov-row"><div class="ov-label">登録方法</div><div class="ov-val">Anthropic Partner Academy 経由で登録・Pearson VUEで日程予約。オンライン監督またはテストセンターで受験。当日は政府発行の写真付きID提示とNDA(機密保持契約)への同意が必要。</div></div>
      </div>
    </details>
  `;
}

function renderLessons() {
  const { examId } = state;
  const meta = EXAM_META[examId];
  const lessonDomains = LESSONS[examId] || [];

  const sections = lessonDomains.map(sec => {
    const d = meta.domains.find(x => x.id === sec.domain);
    const itemsHtml = sec.items.map(it => `
      <div class="lesson-item">
        <div class="lesson-item-title">${it.title}</div>
        <div class="lesson-item-body">${it.body}</div>
      </div>
    `).join('');
    return `<div class="card">
      <div class="domain-tag">${d ? d.name : sec.domain}${d ? ` · ${d.weight}%` : ''}</div>
      ${itemsHtml}
    </div>`;
  }).join('');

  const traps = EXAM_TRAPS[examId];
  const trapsHtml = traps ? `
    <div class="card" style="border-color:var(--accent)">
      <div class="badge-row"><span class="badge" style="background:var(--accent);color:#fff">⚠ 頻出の罠</span></div>
      <h2 style="margin-top:8px">試験で繰り返し出てくるアンチパターン</h2>
      <p>シナリオ問題では、もっともらしいが誤った選択肢としてこれらのパターンが繰り返し登場します。名前で覚えておくと本番で素早く見抜けます。</p>
      ${traps.map(t => `
        <div class="lesson-item">
          <div class="lesson-item-title">${t.name}</div>
          <div class="lesson-item-body">${t.body}</div>
        </div>
      `).join('')}
    </div>
  ` : '';

  const plan = STUDY_PLAN[examId];
  const planHtml = plan ? `
    <div class="card">
      <h2>4週間 学習ロードマップ(例)</h2>
      <p>1日1〜2時間の学習を想定した目安です。配点比率が高いドメインほど厚めに配分しています。</p>
      ${plan.roadmap.map(r => `
        <div class="lesson-item">
          <div class="lesson-item-title">${r.week}: ${r.theme}</div>
          <div class="lesson-item-body">${r.detail}</div>
        </div>
      `).join('')}
    </div>
    <div class="card">
      <h2>推奨リソース(一次情報)</h2>
      <ul style="margin:0; padding-left:20px; color:var(--muted); font-size:0.9rem; line-height:1.9">
        ${plan.resources.map(([label, url]) => `<li><a href="${url}" target="_blank" rel="noopener">${label}</a></li>`).join('')}
      </ul>
    </div>
    ${plan.insights ? `
    <div class="card">
      <h2>先輩受験者の声</h2>
      <p>${plan.insights.source} <a href="${plan.insights.sourceUrl}" target="_blank" rel="noopener">(原文を読む)</a></p>
      <ul style="margin:0 0 14px; padding-left:20px; color:var(--text); font-size:0.9rem; line-height:1.8">
        ${plan.insights.points.map(p => `<li style="margin-bottom:8px">${p}</li>`).join('')}
      </ul>
      <div class="feedback incorrect">
        <div class="verdict">過去問(dumps)サイトについての注意</div>
        <div class="explain">${plan.insights.dumpsWarning}</div>
      </div>
    </div>
    ` : ''}
  ` : '';

  document.getElementById('app').innerHTML = `
    <div class="header">
      <h1>${meta.name}</h1>
      <div class="sub">${meta.code} — ブループリントの各スキル項目に対応した学習レッスン</div>
    </div>
    ${sections}
    ${trapsHtml}
    ${planHtml}
    <div class="btn-row">
      <button class="primary" onclick="startQuiz('${examId}', 20)">クイズに進む(20問)</button>
      <button class="ghost" onclick="go('home')">ホームに戻る</button>
    </div>
  `;
  window.scrollTo(0, 0);
}

function renderTextbook() {
  const { examId, chapter } = state;
  const meta = EXAM_META[examId];
  const chapters = TEXTBOOK[examId] || [];
  if (!chapters.length) { go('home'); return; }
  const idx = Math.min(Math.max(chapter || 0, 0), chapters.length - 1);
  const ch = chapters[idx];
  const d = meta.domains.find(x => x.id === ch.domain);

  const tocHtml = chapters.map((c, i) => {
    const cd = meta.domains.find(x => x.id === c.domain);
    return `<button class="${i === idx ? 'primary' : 'ghost'}" style="font-size:0.78rem;padding:6px 10px" onclick="go('textbook', {examId:'${examId}', chapter:${i}})">第${i + 1}章 ${cd ? cd.name : c.domain}</button>`;
  }).join('');

  const sectionsHtml = ch.sections.map(s => `
    <div class="lesson-item">
      <div class="lesson-item-title">${s.heading}</div>
      <div class="lesson-item-body">${s.body}</div>
    </div>
  `).join('');

  const traps = (EXAM_TRAPS[examId] || []).filter(t => (ch.trapNames || []).includes(t.name));
  const trapsHtml = traps.length ? `
    <div class="card" style="border-color:var(--accent)">
      <div class="badge-row"><span class="badge" style="background:var(--accent);color:#fff">⚠ この章に関連する頻出の罠</span></div>
      ${traps.map(t => `
        <div class="lesson-item">
          <div class="lesson-item-title">${t.name}</div>
          <div class="lesson-item-body">${t.body}</div>
        </div>
      `).join('')}
    </div>
  ` : '';

  const qCountInDomain = QUESTIONS[examId].filter(q => q.domain === ch.domain).length;

  document.getElementById('app').innerHTML = `
    <div class="header">
      <h1>📘 教科書モード</h1>
      <div class="sub">${meta.name} (${meta.code}) — 第${idx + 1}章 / 全${chapters.length}章 — 通読してから演習に進む形式です</div>
    </div>
    <div class="card">
      <div class="btn-row" style="margin-bottom:0">${tocHtml}</div>
    </div>
    <div class="card">
      <div class="domain-tag">${d ? d.name : ch.domain}${d ? ` · ${d.weight}%` : ''}</div>
      <h2 style="margin-top:6px">第${idx + 1}章: ${d ? d.name : ch.domain}</h2>
      ${ch.diagram ? `<div class="diagram-wrap">${ch.diagram}</div>` : ''}
      ${sectionsHtml}
    </div>
    ${trapsHtml}
    <div class="btn-row">
      ${idx > 0 ? `<button onclick="go('textbook', {examId:'${examId}', chapter:${idx - 1}})">← 前の章</button>` : ''}
      ${idx < chapters.length - 1 ? `<button class="primary" onclick="go('textbook', {examId:'${examId}', chapter:${idx + 1}})">次の章 →</button>` : `<button class="primary" onclick="go('lessons', {examId:'${examId}'})">レッスン一覧に戻る</button>`}
    </div>
    <div class="btn-row" style="margin-top:6px">
      <button onclick="startDomainQuiz('${examId}', '${ch.domain}')">この章の問題を演習する(${qCountInDomain}問)</button>
      <button class="ghost" onclick="go('home')">ホームに戻る</button>
    </div>
  `;
  window.scrollTo(0, 0);
}

function renderGlossary() {
  const { examId } = state;
  const meta = EXAM_META[examId];
  const groups = GLOSSARY[examId] || [];
  const html = groups.map(g => `
    <div class="card">
      <h2>${g.category}</h2>
      ${g.terms.map(t => `
        <div class="lesson-item">
          <div class="lesson-item-title">${t.term}</div>
          <div class="lesson-item-body">${t.def}</div>
        </div>
      `).join('')}
    </div>
  `).join('');
  document.getElementById('app').innerHTML = `
    <div class="header">
      <h1>用語集</h1>
      <div class="sub">${meta.code} — 学習・試験対策の参考用語(定義は日本語)</div>
    </div>
    ${html}
    <div class="btn-row">
      <button class="primary" onclick="go('home')">ホームに戻る</button>
    </div>
  `;
  window.scrollTo(0, 0);
}

function renderQuickRef() {
  const { examId } = state;
  const meta = EXAM_META[examId];
  const groups = QUICKREF[examId] || [];
  const html = groups.map(g => {
    const d = meta.domains.find(x => x.id === g.domain);
    return `<div class="card">
      <div class="domain-tag">${d ? d.name : g.domain}${d ? ` · ${d.weight}%` : ''}</div>
      ${g.items.map(it => `
        <div class="lesson-item">
          <div class="lesson-item-title">こう出たら → ${it.trigger}</div>
          <div class="lesson-item-body">✅ <b>${it.pick}</b></div>
        </div>
      `).join('')}
    </div>`;
  }).join('');
  document.getElementById('app').innerHTML = `
    <div class="header">
      <h1>🗂 クイックリファレンス</h1>
      <div class="sub">${meta.code} — 「こう問われたらこれを選ぶ」の早見表。直前の見直し用にドメインごとにまとめています。</div>
    </div>
    ${html}
    <div class="btn-row">
      <button class="primary" onclick="go('home')">ホームに戻る</button>
    </div>
  `;
  window.scrollTo(0, 0);
}

function renderVocab() {
  const { examId } = state;
  const meta = EXAM_META[examId];
  const v = VOCAB[examId];
  if (!v) { go('home'); return; }
  document.getElementById('app').innerHTML = `
    <div class="header">
      <h1>頻出英単語・表現</h1>
      <div class="sub">${meta.code} — 試験は英語のみ・ブラウザ翻訳ツール使用不可のため事前に慣れておく</div>
    </div>
    <div class="card">
      <h2>技術系の動詞・形容詞・副詞</h2>
      ${v.verbs.map(([w, m]) => `<div class="lesson-item"><div class="lesson-item-title">${w}</div><div class="lesson-item-body">${m}</div></div>`).join('')}
    </div>
    <div class="card">
      <h2>頻出略語</h2>
      ${v.acronyms.map(([w, m]) => `<div class="lesson-item"><div class="lesson-item-title">${w}</div><div class="lesson-item-body">${m}</div></div>`).join('')}
    </div>
    <div class="card">
      <h2>設問でよく使われる表現</h2>
      ${v.phrases.map(([w, m]) => `<div class="lesson-item"><div class="lesson-item-title">${w}</div><div class="lesson-item-body">${m}</div></div>`).join('')}
    </div>
    ${v.reasoning ? `<div class="card" style="border-color:var(--accent)">
      <div class="badge-row"><span class="badge" style="background:var(--accent);color:#fff">📊 データ分析済み</span></div>
      <h2 style="margin-top:8px">消去法で使われる語彙</h2>
      <p>うちの110問の解説文を実際に語彙分析して抽出した、誤答を退ける/正解を強調する時に繰り返し出てくる単語です。</p>
      ${v.reasoning.map(([w, m]) => `<div class="lesson-item"><div class="lesson-item-title">${w}</div><div class="lesson-item-body">${m}</div></div>`).join('')}
    </div>` : ''}
    ${v.patterns ? `<div class="card" style="border-color:var(--accent)">
      <div class="badge-row"><span class="badge" style="background:var(--accent);color:#fff">📊 データ分析済み</span></div>
      <h2 style="margin-top:8px">頻出構文パターン</h2>
      <p>同じく110問から抽出した、設問・選択肢で繰り返し出てくる文の構造です。</p>
      ${v.patterns.map(([w, m]) => `<div class="lesson-item"><div class="lesson-item-title">${w}</div><div class="lesson-item-body">${m}</div></div>`).join('')}
    </div>` : ''}
    <div class="btn-row">
      <button class="primary" onclick="go('home')">ホームに戻る</button>
    </div>
  `;
  window.scrollTo(0, 0);
}

/* ---------------- Views ---------------- */

function renderHome() {
  const history = loadHistory();
  const examIds = Object.keys(EXAM_META);
  let html = `
    <div class="header">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px">
        <h1>Claude認定資格 学習トレーナー</h1>
        ${langSwitcherHtml()}
      </div>
      <div class="sub">CCDV-F / CCAR-F / CCAR-P — 公式Exam Guideのブループリントに基づく非公式の練習問題集です。</div>
      <div class="sub" style="margin-top:4px">右上のEN/JAで問題・選択肢・解説の表示言語を切り替えられます(CCDV-Fのみ対応)。実際の試験も2026年10月15日から日本語受験を選べるようになりました。</div>
    </div>
    <div class="card" style="border-color:var(--accent)">
      <div class="badge-row"><span class="badge" style="background:var(--accent);color:#fff">★ 重点対策</span></div>
      <h2 style="margin-top:8px">Developer (CCDV-F) を中心に学習</h2>
      <p style="margin-bottom:0">この学習計画では Claude Certified Developer – Foundations を主軸にしています。出題比重が最も大きい「Applications and Integration」「Model Selection and Optimization」を中心に、8ドメイン全体を厚めの問題数でカバーしています。Architect系(CCAR-F/CCAR-P)は補助教材として引き続き利用できます。</p>
    </div>
    <div class="card">
      <details class="overview" open>
        <summary>3資格共通のルール(登録有効期限・割引・受験配慮・言語)</summary>
        <div class="overview-body">
          <div class="ov-row"><div class="ov-label">受験登録の有効期限</div><div class="ov-val">${PROGRAM_INFO.registrationValidity}</div></div>
          <div class="ov-row"><div class="ov-label">パートナー割引</div><div class="ov-val">${PROGRAM_INFO.discounts}</div></div>
          <div class="ov-row"><div class="ov-label">受験配慮の申請</div><div class="ov-val">${PROGRAM_INFO.accommodations}</div></div>
          <div class="ov-row"><div class="ov-label">試験言語</div><div class="ov-val">${PROGRAM_INFO.language}</div></div>
        </div>
      </details>
    </div>
  `;

  // Show the focus exam first, then the rest in their declared order.
  const orderedIds = [...examIds].sort((a, b) => (EXAM_META[b].focus ? 1 : 0) - (EXAM_META[a].focus ? 1 : 0));

  orderedIds.forEach(id => {
    const meta = EXAM_META[id];
    const qCount = QUESTIONS[id].length;
    const hist = history[id] || [];
    const best = hist.length ? Math.max(...hist.map(h => h.pct)) : null;
    const attempts = hist.length;
    const weakDomains = getWeakDomains(id, 2);

    html += `<div class="card exam-card" ${meta.focus ? 'style="border-color:var(--accent)"' : ''}>
      <div class="top">
        <div>
          <span class="code-pill">${meta.code}</span>
          ${meta.focus ? '<span class="code-pill" style="background:var(--accent);color:#fff;margin-left:6px">重点</span>' : ''}
          <h2 style="margin-top:6px">${meta.name}</h2>
        </div>
      </div>
      <div class="domain-bars">
        ${meta.domains.map(d => `
          <div class="domain-bar-row">
            <div class="name" title="${d.name}">${d.name}</div>
            <div class="domain-bar-track"><div class="domain-bar-fill" style="width:${d.weight}%"></div></div>
            <div class="pct">${d.weight}%</div>
          </div>
        `).join('')}
      </div>
      <div class="badge-row">
        <span class="badge">練習問題 ${qCount}問収録</span>
        <span class="badge">公式試験は${meta.officialItems}問・120分・合格720/1000</span>
      </div>
      ${renderOverview(id)}
      <div class="btn-row">
        ${LESSONS[id] ? `<button class="primary" onclick="go('lessons', {examId:'${id}'})">📖 レッスンを読む</button>` : ''}
        ${TEXTBOOK[id] ? `<button class="primary" onclick="go('textbook', {examId:'${id}', chapter:0})">📘 教科書モードで読む</button>` : ''}
        ${qCount >= meta.officialItems
          ? [1, 2, 3].map(n => `<button ${n === 1 && !LESSONS[id] ? 'class="primary"' : ''} onclick="startMock('${id}', ${n})">模試${n}(${meta.officialItems}問)</button>`).join('')
          : ''
        }
        <button onclick="startQuiz('${id}', ${qCount})">全問(${qCount}問)で自由演習</button>
      </div>
      <div class="btn-row" style="margin-top:6px">
        ${(() => {
          if (!weakDomains.length) return `<button class="ghost" disabled title="2回以上受験するとドメイン別成績から苦手分野を判定します">🎯 苦手ドメインを演習(履歴不足)</button>`;
          const belowLine = weakDomains.filter(d => d.acc < 0.72);
          const n = belowLine.length ? belowLine.length : Math.min(2, weakDomains.length);
          return `<button onclick="startWeakDomainQuiz('${id}')">🎯 苦手ドメインを演習(${n}ドメイン)</button>`;
        })()}
        ${hist.length ? `<button class="ghost" onclick="reviewLastMistakes('${id}')" ${!(hist[hist.length-1].missed && hist[hist.length-1].missed.length) ? 'disabled' : ''}>前回の間違いを復習</button>` : ''}
      </div>
      <div class="btn-row" style="margin-top:6px">
        ${QUICKREF[id] ? `<button class="ghost" onclick="go('quickref', {examId:'${id}'})">🗂 クイックリファレンス</button>` : ''}
        ${GLOSSARY[id] ? `<button class="ghost" onclick="go('glossary', {examId:'${id}'})">📚 用語集</button>` : ''}
        ${VOCAB[id] ? `<button class="ghost" onclick="go('vocab', {examId:'${id}'})">🔤 頻出英単語(試験は英語のみ)</button>` : ''}
      </div>
      <div class="stats-line">${attempts ? `これまで${attempts}回受験・自己ベスト ${best}%` : 'まだ受験履歴はありません'}</div>
    </div>`;
  });

  html += `<div class="footer-note">
    このアプリは Anthropic 非公式の学習支援ツールです。設問は公開されている各 Exam Guide のブループリント(出題ドメインと重み、知識・スキル項目)をもとにした独自作成のオリジナル問題であり、実際の試験問題そのものではありません。実際の出題内容は受験規約により非開示(NDA)です。正式な出題範囲・登録方法は Anthropic Partner Academy の Exam Guide を必ずご確認ください。
  </div>`;

  document.getElementById('app').innerHTML = html;
}

function startQuiz(examId, count) {
  const set = buildQuizSet(examId, count);
  go('quiz', {
    examId,
    questions: set,
    qIndex: 0,
    selected: null,
    answered: false,
    results: [], // { idx, domain, correct, selected }
  });
}

/* Full-length mock exam matching the official item count, rotating through the bank
   across mock 1/2/3 so repeats are minimized until the bank wraps around. */
function startMock(examId, mockNumber) {
  const meta = EXAM_META[examId];
  const set = buildMockSet(examId, meta.officialItems);
  go('quiz', {
    examId,
    mockLabel: `模試${mockNumber}`,
    questions: set,
    qIndex: 0,
    selected: null,
    answered: false,
    results: [],
  });
}

/* Build a quiz drawn only from the weakest domain(s) in the candidate's history so far. */
function startWeakDomainQuiz(examId) {
  const weak = getWeakDomains(examId, 2); // need at least 2 prior attempts in a domain to trust the signal
  if (!weak.length) return;
  const threshold = 0.72; // matches the app's pass-line approximation
  let targets = weak.filter(d => d.acc < threshold);
  if (!targets.length) targets = weak.slice(0, 2); // no domain below threshold: drill the two weakest anyway
  const targetIds = new Set(targets.map(d => d.id));

  const allQ = QUESTIONS[examId].map((q, idx) => ({ ...q, _idx: idx }));
  const pool = allQ.filter(q => targetIds.has(q.domain));
  const meta = EXAM_META[examId];
  const label = '苦手ドメイン演習: ' + targets.map(d => {
    const dm = meta.domains.find(x => x.id === d.id);
    return dm ? dm.name : d.id;
  }).join(' / ');

  go('quiz', {
    examId,
    mockLabel: label,
    questions: shuffle(pool).map(q => shuffleChoices(q, examId)),
    qIndex: 0,
    selected: null,
    answered: false,
    results: [],
  });
}

/* Practice restricted to a single chosen domain — used by textbook mode's "この章の問題を演習する". */
function startDomainQuiz(examId, domainId) {
  const meta = EXAM_META[examId];
  const dm = meta.domains.find(x => x.id === domainId);
  const allQ = QUESTIONS[examId].map((q, idx) => ({ ...q, _idx: idx }));
  const pool = allQ.filter(q => q.domain === domainId);
  go('quiz', {
    examId,
    domainId,
    mockLabel: `章別演習: ${dm ? dm.name : domainId}`,
    questions: shuffle(pool).map(q => shuffleChoices(q, examId)),
    qIndex: 0,
    selected: null,
    answered: false,
    results: [],
  });
}

function renderQuiz() {
  const { examId, questions, qIndex, selected, answered, mockLabel } = state;
  const meta = EXAM_META[examId];
  const q = questions[qIndex];
  const domainMeta = meta.domains.find(d => d.id === q.domain);
  const lang = loadLang();
  const ja = q.ja;
  const useJa = lang === 'ja' && !!ja;
  const domainName = (useJa ? domainMeta?.nameJa : domainMeta?.name) || domainMeta?.name || q.domain;
  const pct = Math.round((qIndex / questions.length) * 100);
  const isMulti = Array.isArray(q.answer);
  const selectedArr = isMulti ? (Array.isArray(selected) ? selected : []) : null;

  const displayQ = useJa ? ja.q : q.q;
  const displayChoices = useJa ? ja.choices : q.choices;
  const displayExplain = useJa ? ja.explain : q.explain;

  let choicesHtml = q.choices.map((c, i) => {
    let cls = 'choice';
    const isSelected = isMulti ? selectedArr.includes(i) : i === selected;
    if (answered) {
      cls += ' disabled';
      const isCorrectChoice = isMulti ? q.answer.includes(i) : i === q.answer;
      if (isCorrectChoice) cls += ' correct';
      else if (isSelected) cls += ' incorrect';
    } else if (isSelected) {
      cls += ' selected';
    }
    return `<div class="${cls}" onclick="${answered ? '' : `selectChoice(${i})`}">
      <input type="${isMulti ? 'checkbox' : 'radio'}" name="choice" ${isSelected ? 'checked' : ''} ${answered ? 'disabled' : ''} readonly>
      <div class="label">${displayChoices[i]}</div>
    </div>`;
  }).join('');

  let feedbackHtml = '';
  if (answered) {
    const isCorrect = isAnswerCorrect(q, selected);
    feedbackHtml = `<div class="feedback ${isCorrect ? 'correct' : 'incorrect'}">
      <div class="verdict">${isCorrect ? '正解です' : '不正解'}</div>
      <div class="explain">${displayExplain}</div>
    </div>`;
  }

  let jaHtml = '';
  if (ja) {
    jaHtml = useJa
      ? `<details class="overview ja-block">
          <summary>English originalを見る</summary>
          <div class="overview-body">
            <div class="ov-row"><div class="ov-label">Question</div><div class="ov-val">${q.q}</div></div>
            <div class="ov-row"><div class="ov-label">Choices</div><div class="ov-val">${q.choices.map((c,i)=>`${String.fromCharCode(65+i)}. ${c}`).join('<br>')}</div></div>
            ${answered ? `<div class="ov-row"><div class="ov-label">Explanation</div><div class="ov-val">${q.explain}</div></div>` : ''}
          </div>
        </details>`
      : `<details class="overview ja-block">
          <summary>日本語訳を見る</summary>
          <div class="overview-body">
            <div class="ov-row"><div class="ov-label">問題文</div><div class="ov-val">${ja.q}</div></div>
            <div class="ov-row"><div class="ov-label">選択肢</div><div class="ov-val">${ja.choices.map((c,i)=>`${String.fromCharCode(65+i)}. ${c}`).join('<br>')}</div></div>
            ${answered ? `<div class="ov-row"><div class="ov-label">解説</div><div class="ov-val">${ja.explain}</div></div>` : ''}
          </div>
        </details>`;
  }

  const isLast = qIndex === questions.length - 1;

  document.getElementById('app').innerHTML = `
    <div class="quiz-meta">
      <span>${meta.code}${mockLabel ? ` · ${mockLabel}` : ''}</span>
      <span>${qIndex + 1} / ${questions.length}</span>
    </div>
    <div class="quiz-top">
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      ${langSwitcherHtml()}
    </div>
    <div class="card">
      <div class="domain-tag">${domainName}</div>
      ${isMulti ? `<div class="badge" style="margin-bottom:8px">正解を${q.answer.length}つ選択してください</div>` : ''}
      <div class="question-text">${displayQ}</div>
      ${choicesHtml}
      ${feedbackHtml}
      ${jaHtml}
      <div class="btn-row">
        ${!answered
          ? `<button class="primary" onclick="submitAnswer()" ${(isMulti ? selectedArr.length !== q.answer.length : selected === null) ? 'disabled' : ''}>回答する</button>`
          : `<button class="primary" onclick="${isLast ? 'finishQuiz()' : 'nextQuestion()'}">${isLast ? '結果を見る' : '次の問題へ'}</button>`
        }
        <button class="ghost" onclick="if(confirm('クイズを中断してホームに戻りますか？')) go('home')">中断する</button>
      </div>
    </div>
  `;
}

function selectChoice(i) {
  if (state.answered) return;
  const q = state.questions[state.qIndex];
  if (Array.isArray(q.answer)) {
    const sel = Array.isArray(state.selected) ? state.selected.slice() : [];
    const pos = sel.indexOf(i);
    if (pos >= 0) sel.splice(pos, 1); else sel.push(i);
    state.selected = sel;
  } else {
    state.selected = i;
  }
  render();
}

function submitAnswer() {
  if (state.answered) return;
  const q = state.questions[state.qIndex];
  const isMulti = Array.isArray(q.answer);
  if (isMulti) {
    if (!Array.isArray(state.selected) || state.selected.length !== q.answer.length) return;
  } else if (state.selected === null) {
    return;
  }
  state.answered = true;
  state.results.push({
    idx: q._idx,
    domain: q.domain,
    correct: isAnswerCorrect(q, state.selected),
    selectedText: isMulti ? state.selected.slice().sort((a, b) => a - b).map(i => q.choices[i]).join(' / ') : q.choices[state.selected],
    correctText: isMulti ? q.answer.map(i => q.choices[i]).join(' / ') : q.choices[q.answer],
    q: q.q,
    explain: q.explain,
    ja: q.ja,
  });
  render();
}

function nextQuestion() {
  state.qIndex++;
  state.selected = null;
  state.answered = false;
  render();
}

function finishQuiz() {
  const { examId, questions, results, mockLabel, domainId } = state;
  const meta = EXAM_META[examId];
  const correctCount = results.filter(r => r.correct).length;
  const pct = Math.round((correctCount / results.length) * 100);

  const byDomain = {};
  meta.domains.forEach(d => { byDomain[d.id] = { name: d.name, nameJa: d.nameJa, correct: 0, total: 0 }; });
  results.forEach(r => {
    if (!byDomain[r.domain]) byDomain[r.domain] = { name: r.domain, correct: 0, total: 0 };
    byDomain[r.domain].total++;
    if (r.correct) byDomain[r.domain].correct++;
  });

  const missed = results.filter(r => !r.correct).map(r => r.idx);

  const history = loadHistory();
  history[examId] = history[examId] || [];
  history[examId].push({
    date: new Date().toISOString(),
    total: results.length,
    correct: correctCount,
    pct,
    missed,
  });
  saveHistory(history);
  recordDomainStats(examId, byDomain);

  go('results', { examId, results, pct, correctCount, total: results.length, byDomain, mockLabel, domainId });
}

function renderResults() {
  const { examId, results, pct, correctCount, total, byDomain, mockLabel, domainId } = state;
  const meta = EXAM_META[examId];
  const passed = pct >= 72; // approximation of the 720/1000 scaled cut score
  const missedResults = results.filter(r => !r.correct);

  const lang = loadLang();
  let domainHtml = Object.values(byDomain).filter(d => d.total > 0).map(d => {
    const dp = Math.round((d.correct / d.total) * 100);
    const label = (lang === 'ja' && d.nameJa) ? d.nameJa : d.name;
    return `<div class="domain-bar-row">
      <div class="name" title="${label}">${label}</div>
      <div class="domain-bar-track"><div class="domain-bar-fill" style="width:${dp}%; background:${dp >= 72 ? 'var(--good)' : 'var(--bad)'}"></div></div>
      <div class="pct">${d.correct}/${d.total}</div>
    </div>`;
  }).join('');

  let reviewHtml = missedResults.length ? `<div class="card">
      <h2>間違えた問題の復習 (${missedResults.length}問)</h2>
      ${missedResults.map(r => {
        const ja = r.ja;
        const useJa = lang === 'ja' && !!ja;
        const jaBlock = ja ? (useJa
          ? `<details class="overview ja-block">
              <summary>English originalを見る</summary>
              <div class="overview-body">
                <div class="ov-row"><div class="ov-label">Question</div><div class="ov-val">${r.q}</div></div>
                <div class="ov-row"><div class="ov-label">Explanation</div><div class="ov-val">${r.explain}</div></div>
              </div>
            </details>`
          : `<details class="overview ja-block">
              <summary>日本語訳を見る</summary>
              <div class="overview-body">
                <div class="ov-row"><div class="ov-label">問題文</div><div class="ov-val">${ja.q}</div></div>
                <div class="ov-row"><div class="ov-label">解説</div><div class="ov-val">${ja.explain}</div></div>
              </div>
            </details>`) : '';
        return `
        <div class="review-item">
          <div class="q">${useJa ? ja.q : r.q}</div>
          <div class="ans-line your-wrong">あなたの回答: ${r.selectedText}</div>
          <div class="ans-line correct-ans">正解: ${r.correctText}</div>
          <div class="explain">${useJa ? ja.explain : r.explain}</div>
          ${jaBlock}
        </div>
      `;
      }).join('')}
    </div>` : `<div class="card"><p>すべて正解でした。素晴らしいです。</p></div>`;

  document.getElementById('app').innerHTML = `
    <div class="header"><h1>結果${mockLabel ? ` — ${mockLabel}` : ''}</h1><div class="sub">${meta.name} (${meta.code})</div></div>
    <div class="card">
      <div class="score-hero">
        <div class="big ${passed ? 'verdict-pass' : 'verdict-fail'}">${pct}%</div>
        <div class="caption">${correctCount} / ${total} 問正解 — ${passed ? '合格ライン(目安72%)を上回りました' : '合格ライン(目安72%)には届いていません'}</div>
        <div class="caption">※ 実際の採点は100〜1000のスケールスコア(合格720)。ここでの72%はあくまで簡易換算の目安です。</div>
      </div>
    </div>
    <div class="card">
      <h2>ドメイン別正答率</h2>
      <div class="domain-bars">${domainHtml}</div>
    </div>
    ${reviewHtml}
    <div class="btn-row">
      <button class="primary" onclick="go('home')">ホームに戻る</button>
      <button onclick="${
        mockLabel && mockLabel.startsWith('模試') ? `startMock('${examId}', ${parseInt(mockLabel.replace('模試',''),10)})`
        : mockLabel && mockLabel.startsWith('苦手ドメイン演習') ? `startWeakDomainQuiz('${examId}')`
        : mockLabel && mockLabel.startsWith('章別演習') && domainId ? `startDomainQuiz('${examId}', '${domainId}')`
        : `startQuiz('${examId}', ${total})`
      }">もう一度同じ問題数で挑戦</button>
    </div>
  `;
}

function reviewLastMistakes(examId) {
  const history = loadHistory();
  const hist = history[examId];
  if (!hist || !hist.length) return;
  const last = hist[hist.length - 1];
  const missedIdx = last.missed || [];
  if (!missedIdx.length) return;
  const set = missedIdx.map(idx => ({ ...QUESTIONS[examId][idx], _idx: idx }));
  go('quiz', {
    examId,
    questions: shuffle(set).map(q => shuffleChoices(q, examId)),
    qIndex: 0,
    selected: null,
    answered: false,
    results: [],
  });
}

function render() {
  if (state.route === 'home') renderHome();
  else if (state.route === 'lessons') renderLessons();
  else if (state.route === 'textbook') renderTextbook();
  else if (state.route === 'quickref') renderQuickRef();
  else if (state.route === 'glossary') renderGlossary();
  else if (state.route === 'vocab') renderVocab();
  else if (state.route === 'quiz') renderQuiz();
  else if (state.route === 'results') renderResults();
}

render();
