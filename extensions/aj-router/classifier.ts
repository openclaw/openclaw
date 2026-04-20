/**
 * Heuristic prompt classifier.
 *
 * v1 avoids any LLM call: we pattern-match on prompt shape, length, and
 * keywords to produce a `{ tier, confidence }` decision. The `before_model_resolve`
 * hook runs on every request, so the classifier must be cheap and deterministic.
 *
 * When `classifier.mode === "llm"` is wired up in a follow-up, the same
 * return shape is emitted by an LLM call so downstream code is unchanged.
 */

import type { ClassifierTier } from "./config.js";

export type Classification = {
  tier: ClassifierTier;
  confidence: number;
  /** Short human-readable explanation of the decision (used by /router explain). */
  reason: string;
};

const SIMPLE_PATTERNS: readonly RegExp[] = [
  /\b(classify|categorize|categorise|label|tag)\b/i,
  /\b(extract|pull|parse)\s+(out\s+)?(the|this|these)?\b/i,
  /\b(yes|no)\??\s*$/i,
  /\b(is|are|was|were)\s+(this|that|these|those)\s+/i,
  /\b(translate|convert|reformat|rename)\b/i,
  /\bsentiment\b/i,
  /\bsummari[sz]e\s+(in|to)\s+\w+\s+(words?|sentences?|bullet)/i,
];

const COMPLEX_PATTERNS: readonly RegExp[] = [
  /\b(architect(ure)?|design\s+a\s+system|refactor\s+the\s+entire)/i,
  /\b(multi-?agent|orchestrate|coordinate\s+(several|multiple))/i,
  /\b(full[- ]codebase|whole\s+repo|across\s+the\s+codebase)/i,
  /\b(legal|privilege[d]?|evidence|attorney[- ]client)/i,
  /\b(financial\s+model|deal\s+memo|pro[- ]?forma)/i,
  /\bplan\s+(a\s+)?(migration|rollout|release)/i,
];

const SHORT_PROMPT_CHARS = 200;
const LONG_PROMPT_CHARS = 4000;

export type ClassifyParams = {
  prompt: string;
};

function matchesAny(text: string, patterns: readonly RegExp[]): RegExp | undefined {
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      return pattern;
    }
  }
  return undefined;
}

/**
 * Heuristic classifier. Returns the tier plus a confidence score.
 *
 * Scoring:
 * - Long prompts (>4000 chars) → `complex` with 0.9 confidence
 * - Explicit complex keywords → `complex` with 0.9 confidence
 * - Short prompts (<200 chars) matching simple patterns → `simple` with 0.9 confidence
 * - Short prompts without simple-pattern match → `simple` with 0.7 confidence (will escalate)
 * - Everything else → `medium` with 0.85 confidence
 *
 * The confidence values are tuned so the default `escalationThreshold` of 0.85
 * lets clearly-simple and clearly-complex requests through without escalation,
 * while genuinely ambiguous requests bump up one tier.
 */
export function classifyHeuristic(params: ClassifyParams): Classification {
  const prompt = params.prompt ?? "";
  const trimmed = prompt.trim();
  const length = trimmed.length;

  const complexMatch = matchesAny(trimmed, COMPLEX_PATTERNS);
  if (complexMatch) {
    return {
      tier: "complex",
      confidence: 0.9,
      reason: `matched complex keyword: ${complexMatch.source}`,
    };
  }

  if (length > LONG_PROMPT_CHARS) {
    return {
      tier: "complex",
      confidence: 0.9,
      reason: `long prompt (${length} chars > ${LONG_PROMPT_CHARS})`,
    };
  }

  const simpleMatch = matchesAny(trimmed, SIMPLE_PATTERNS);
  if (simpleMatch && length < SHORT_PROMPT_CHARS) {
    return {
      tier: "simple",
      confidence: 0.9,
      reason: `short prompt with simple keyword: ${simpleMatch.source}`,
    };
  }

  if (simpleMatch) {
    return {
      tier: "simple",
      confidence: 0.75,
      reason: `simple keyword matched but prompt is not short (${length} chars)`,
    };
  }

  if (length < SHORT_PROMPT_CHARS) {
    return {
      tier: "simple",
      confidence: 0.7,
      reason: `short prompt (${length} chars < ${SHORT_PROMPT_CHARS}) without clear signal`,
    };
  }

  return {
    tier: "medium",
    confidence: 0.85,
    reason: `default medium tier (${length} chars, no special patterns)`,
  };
}
