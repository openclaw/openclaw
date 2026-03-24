import type { ClassificationResult, DimensionScores, PromptTier } from "./types.js";

// ---------------------------------------------------------------------------
// Dimension weights (sum = 1.0)
// ---------------------------------------------------------------------------
const WEIGHTS: Record<keyof DimensionScores, number> = {
  reasoningMarkers: 0.25,
  codePresence: 0.22,
  multiStepPatterns: 0.18,
  technicalTerms: 0.15,
  tokenEstimate: 0.1,
  simpleIndicators: 0.1,
};

// ---------------------------------------------------------------------------
// Tier boundaries on the weighted-score axis
// ---------------------------------------------------------------------------
const TIER_SIMPLE_MAX = 0.05;
const TIER_MEDIUM_MAX = 0.25;
const TIER_COMPLEX_MAX = 0.45;

// ---------------------------------------------------------------------------
// Keyword / pattern lists
// ---------------------------------------------------------------------------

const REASONING_KEYWORDS = [
  "prove",
  "theorem",
  "derive",
  "step by step",
  "chain of thought",
  "formally",
  "mathematical",
  "proof",
  "logically",
  "reason through",
  "analyze why",
  "deduce",
];

const CODE_KEYWORDS = [
  "function",
  "class ",
  "import ",
  "export ",
  "def ",
  "const ",
  "let ",
  "var ",
  "return ",
  "async ",
  "await ",
  "=>",
  "interface ",
  "type ",
  "struct ",
  "impl ",
  "fn ",
];

const MULTI_STEP_PATTERNS = [
  /first\b.*\bthen\b/is,
  /step\s+\d/i,
  /\d+\.\s+\S/,
  /after that\b/i,
  /next,?\s/i,
  /finally\b/i,
];

const TECHNICAL_TERMS = [
  "algorithm",
  "optimize",
  "architecture",
  "distributed",
  "kubernetes",
  "microservice",
  "database",
  "infrastructure",
  "implement",
  "refactor",
  "debug",
  "deploy",
  "benchmark",
  "latency",
  "throughput",
  "routing",
  "state management",
  "api",
  "authentication",
  "caching",
  "error handling",
  "monitoring",
];

const SIMPLE_INDICATORS = [
  "what is",
  "define",
  "translate",
  "hello",
  "yes or no",
  "capital of",
  "how old",
  "who is",
  "when was",
  "thanks",
  "thank you",
  "hi",
  "hey",
  "good morning",
  "good night",
];

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

function countKeywordMatches(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) count++;
  }
  return count;
}

function countPatternMatches(text: string, patterns: RegExp[]): number {
  let count = 0;
  for (const p of patterns) {
    if (p.test(text)) count++;
  }
  return count;
}

function hasCodeFence(text: string): boolean {
  return text.includes("```");
}

function estimateWordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Map a raw count to a 0–1 score using low/high thresholds. */
function thresholdScore(count: number, low: number, high: number): number {
  if (count >= high) return 1.0;
  if (count >= low) return 0.5;
  return 0;
}

// ---------------------------------------------------------------------------
// Dimension scorers
// ---------------------------------------------------------------------------

function scoreReasoningMarkers(text: string): number {
  const matches = countKeywordMatches(text, REASONING_KEYWORDS);
  if (matches >= 2) return 1.0;
  if (matches >= 1) return 0.7;
  return 0;
}

function scoreCodePresence(text: string): number {
  if (hasCodeFence(text)) return 1.0;
  const matches = countKeywordMatches(text, CODE_KEYWORDS);
  return thresholdScore(matches, 1, 3);
}

function scoreMultiStepPatterns(text: string): number {
  const matches = countPatternMatches(text, MULTI_STEP_PATTERNS);
  return thresholdScore(matches, 1, 2);
}

function scoreTechnicalTerms(text: string): number {
  const matches = countKeywordMatches(text, TECHNICAL_TERMS);
  return thresholdScore(matches, 1, 3);
}

function scoreTokenEstimate(text: string): number {
  const words = estimateWordCount(text);
  if (words > 200) return 1.0;
  if (words > 80) return 0.5;
  if (words > 30) return 0.2;
  if (words < 6) return -0.5;
  return 0;
}

/** Negative signal — presence pulls score down. */
function scoreSimpleIndicators(text: string): number {
  const matches = countKeywordMatches(text, SIMPLE_INDICATORS);
  if (matches >= 2) return -1.0;
  if (matches >= 1) return -0.7;
  return 0;
}

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

function computeScores(prompt: string): DimensionScores {
  return {
    reasoningMarkers: scoreReasoningMarkers(prompt),
    codePresence: scoreCodePresence(prompt),
    multiStepPatterns: scoreMultiStepPatterns(prompt),
    technicalTerms: scoreTechnicalTerms(prompt),
    tokenEstimate: scoreTokenEstimate(prompt),
    simpleIndicators: scoreSimpleIndicators(prompt),
  };
}

function computeWeightedScore(scores: DimensionScores): number {
  let total = 0;
  for (const dim of Object.keys(WEIGHTS) as (keyof DimensionScores)[]) {
    total += scores[dim] * WEIGHTS[dim];
  }
  return total;
}

function tierFromScore(score: number): PromptTier {
  if (score < TIER_SIMPLE_MAX) return "simple";
  if (score < TIER_MEDIUM_MAX) return "medium";
  if (score < TIER_COMPLEX_MAX) return "complex";
  return "reasoning";
}

/** Distance from the nearest tier boundary, normalised to [0, 1]. */
function computeConfidence(score: number, tier: PromptTier): number {
  const boundaries = [TIER_SIMPLE_MAX, TIER_MEDIUM_MAX, TIER_COMPLEX_MAX];
  let minDist = Infinity;
  for (const b of boundaries) {
    const d = Math.abs(score - b);
    if (d < minDist) minDist = d;
  }
  // Sigmoid-like scaling: scores far from boundaries → high confidence
  const steepness = 12;
  return 1 / (1 + Math.exp(-steepness * minDist));
}

export function classifyPrompt(prompt: string): ClassificationResult {
  const text = prompt.trim();
  if (!text) {
    return { tier: "simple", confidence: 1, weightedScore: 0, scores: computeScores("") };
  }

  const scores = computeScores(text);
  const weightedScore = computeWeightedScore(scores);

  // Force REASONING if 2+ reasoning keyword matches
  const reasoningMatches = countKeywordMatches(text, REASONING_KEYWORDS);
  if (reasoningMatches >= 2) {
    const conf = Math.max(computeConfidence(weightedScore, "reasoning"), 0.85);
    return { tier: "reasoning", confidence: conf, weightedScore, scores };
  }

  const tier = tierFromScore(weightedScore);
  const confidence = computeConfidence(weightedScore, tier);

  return { tier, confidence, weightedScore, scores };
}
