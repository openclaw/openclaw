import type { RecordType } from "./types";

// ── Types ────────────────────────────────────────────────────

export type PerceptorSource =
  | "correction"
  | "rule_constraint"
  | "explicit_preference"
  | "memory_request"
  | "time_commitment"
  | "identity";

export interface PerceptorSignal {
  type: RecordType;
  importance: number;
  confidence: number;
  keywords: string[];
  source: PerceptorSource;
}

export interface PerceptorResult {
  signal: PerceptorSignal | null;
  durationMs: number;
}

// ── Priority ─────────────────────────────────────────────────

const SOURCE_PRIORITY: readonly PerceptorSource[] = [
  "correction",
  "rule_constraint",
  "explicit_preference",
  "memory_request",
  "time_commitment",
  "identity",
];

const PRIORITY_RANK: Record<PerceptorSource, number> = {
  correction: 0,
  rule_constraint: 1,
  explicit_preference: 2,
  memory_request: 3,
  time_commitment: 4,
  identity: 5,
};

// ── Keyword extraction ───────────────────────────────────────

const STOP_WORDS = new Set([
  "的",
  "了",
  "是",
  "在",
  "我",
  "你",
  "他",
  "她",
  "它",
  "们",
  "这",
  "那",
  "不",
  "也",
  "就",
  "都",
  "要",
  "会",
  "和",
  "与",
  "很",
  "更",
  "最",
  "有",
  "没",
  "个",
  "把",
  "被",
  "让",
  "给",
  "对",
  "从",
  "到",
  "上",
  "下",
  "里",
  "中",
  "说",
  "想",
  "看",
  "来",
  "去",
  "做",
  "能",
  "可以",
  "应该",
  "还是",
  "比较",
  "非常",
  "一个",
  "这个",
  "那个",
  "什么",
  "怎么",
  "为什么",
  "因为",
  "所以",
  "但是",
  "如果",
  "虽然",
  "然后",
  "而且",
  "或者",
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "shall",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "it",
  "its",
  "and",
  "or",
  "but",
  "not",
  "no",
  "so",
  "as",
  "this",
  "that",
  "these",
  "those",
  "i",
  "you",
  "he",
  "she",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "his",
  "our",
  "their",
  "just",
  "about",
  "very",
  "really",
]);

function extractKeywords(text: string): string[] {
  const results: string[] = [];

  // Chinese: extract 2-4 char n-grams, shorter first (more specific)
  const cjkRuns = text.match(/[一-鿿㐀-䶿]{2,}/g) ?? [];
  for (const run of cjkRuns) {
    for (let len = 2; len <= 4; len++) {
      for (let i = 0; i <= run.length - len; i++) {
        const gram = run.slice(i, i + len);
        if (!STOP_WORDS.has(gram)) {
          results.push(gram);
        }
      }
    }
  }

  // English: lowercase alphanumeric words >= 3 chars
  const enWords = text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  for (const w of enWords) {
    if (!STOP_WORDS.has(w)) results.push(w);
  }

  return [...new Set(results)].slice(0, 8);
}

// ── Detectors ────────────────────────────────────────────────

// Detector 1: Correction / Negation (priority: highest)
const CORRECTION_RE =
  /不对|上次说的不对|说错了|记错了|纠正|不是.{1,4}是|搞错了|弄错了|你记错了|之前说的不对/;

function detectCorrection(text: string): PerceptorSignal | null {
  if (!CORRECTION_RE.test(text)) return null;
  return {
    type: "fact",
    importance: 7,
    confidence: 0.9,
    keywords: extractKeywords(text),
    source: "correction",
  };
}

// Detector 2: Rule / Constraint
const RULE_RE = /必须|禁止|不得|不允许|一定要|决不能|千万别|不准|严禁|务必|只能|不可以/;

function detectRuleConstraint(text: string): PerceptorSignal | null {
  if (!RULE_RE.test(text)) return null;
  return {
    type: "rule",
    importance: 8,
    confidence: 0.9,
    keywords: extractKeywords(text),
    source: "rule_constraint",
  };
}

// Detector 3: Explicit Preference
const PREFERENCE_RE =
  /不喜欢|更倾向|最好用|更喜欢|更爱|更想|讨厌|受不了|宁愿|最爱|最喜欢|偏好|倾向于|宁可/;

function detectExplicitPreference(text: string): PerceptorSignal | null {
  if (!PREFERENCE_RE.test(text)) return null;
  return {
    type: "preference",
    importance: 6,
    confidence: 0.85,
    keywords: extractKeywords(text),
    source: "explicit_preference",
  };
}

// Detector 4: Explicit Memory Request ("帮我记一下" etc.)
const MEMORY_REQUEST_RE =
  /帮我记|记住|别忘了|记下来|记一下|帮我存|存一下|你帮我记|别忘了|帮我备注|备注一下/;

function detectMemoryRequest(text: string): PerceptorSignal | null {
  if (!MEMORY_REQUEST_RE.test(text)) return null;
  // The text following the directive is what should be memorized.
  // Strip the directive prefix for a cleaner summary.
  const cleaned = text
    .replace(/你?帮我?(记一下|记住|记下来|存一下|备注一下|别忘了)[，,]?\s*/g, "")
    .trim();
  return {
    type: cleaned.length > 0 ? "fact" : "fact",
    importance: 5,
    confidence: 0.85,
    keywords: extractKeywords(cleaned || text),
    source: "memory_request",
  };
}

// Detector 5: Time Commitment
const TIME_EXPR_RE =
  /周五|周六|周日|周一|周二|周三|周四|星期[一二三四五六日]|下周[一二三四五六日]?|下个月|明年|月底|月初|年末|年底|这周|这个月|明天|后天|改天|回头|这周末|下周末|春节|元旦|五一|国庆|暑假|寒假|放假|周末/;
const TIME_ACTION_RE = /要|会|准备|打算|计划|想|去|做|参加|完成|交|提交|写完|搞完|之前|以前|的时候/;

function detectTimeCommitment(text: string): PerceptorSignal | null {
  const timeMatch = TIME_EXPR_RE.exec(text);
  if (!timeMatch) return null;

  const afterTime = text.slice(timeMatch.index + timeMatch[0].length);
  // action verb must appear within 15 chars after the time expression
  if (!TIME_ACTION_RE.test(afterTime.slice(0, 15))) return null;

  return {
    type: "plan",
    importance: 5,
    confidence: 0.7,
    keywords: extractKeywords(text),
    source: "time_commitment",
  };
}

// Detector 6: Identity
const IDENTITY_RE =
  /我(?:叫|是|住在|在|姓|的|今年|属|喜欢|讨厌|有(?:一[个只台辆])?)|我的.{1,6}(?:是|叫|在|喜欢|住)/;

function detectIdentity(text: string): PerceptorSignal | null {
  if (!IDENTITY_RE.test(text)) return null;
  // identity is low signal without additional context — require stronger match
  const strongMatch =
    /我叫.{1,10}|我住在.{1,20}|我是.{1,10}(?:的|工程师|老师|医生|经理|设计师|程序员|学生)|我是一名|我在.{1,15}工作|我今年\d{1,3}岁|我的职业是/.test(
      text,
    );
  if (!strongMatch) return null;
  return {
    type: "fact",
    importance: 4,
    confidence: 0.6,
    keywords: extractKeywords(text),
    source: "identity",
  };
}

// ── Detector registry ────────────────────────────────────────

type DetectorFn = (text: string) => PerceptorSignal | null;

const DETECTORS: [PerceptorSource, DetectorFn][] = [
  ["correction", detectCorrection],
  ["rule_constraint", detectRuleConstraint],
  ["explicit_preference", detectExplicitPreference],
  ["memory_request", detectMemoryRequest],
  ["time_commitment", detectTimeCommitment],
  ["identity", detectIdentity],
];

// ── Public API ───────────────────────────────────────────────

export function analyzeMessage(text: string): PerceptorResult {
  const t0 = performance.now();

  if (!text || text.trim().length < 3) {
    return { signal: null, durationMs: performance.now() - t0 };
  }

  let bestSignal: PerceptorSignal | null = null;
  let bestRank = Infinity;

  for (const [source, detector] of DETECTORS) {
    const signal = detector(text);
    if (signal) {
      const rank = PRIORITY_RANK[source];
      if (rank < bestRank) {
        bestRank = rank;
        bestSignal = signal;
      }
    }
  }

  return { signal: bestSignal, durationMs: performance.now() - t0 };
}

export { PRIORITY_RANK, SOURCE_PRIORITY };
