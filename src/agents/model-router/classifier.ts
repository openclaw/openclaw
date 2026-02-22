export type ComplexityLevel = "simple" | "moderate" | "complex";

const CODE_PATTERNS = /```|function\s|class\s|import\s|export\s|const\s+\w+\s*=|interface\s/;
const ANALYSIS_KEYWORDS = /\b(analyze|compare|evaluate|review|audit|assess|inspect)\b/i;
const MATH_KEYWORDS = /\b(calculate|compute|solve|prove|derive|formula|equation)\b/i;
const MULTI_STEP = /\b(first\b.*\bthen\b|step\s+\d|phase\s+\d)/is;
const CREATIVE_KEYWORDS = /\b(write a story|create a|design a|build a|generate a)\b/i;

/**
 * Estimate token count from a stringified message payload.
 * Uses a rough 1-token-per-4-chars heuristic (good enough for routing).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Score the complexity of a conversation based on message content.
 * Returns a numeric score used to classify into simple/moderate/complex.
 */
function scoreMessages(messages: unknown[]): number {
  let score = 0;
  const text = JSON.stringify(messages);

  if (CODE_PATTERNS.test(text)) {
    score += 2;
  }
  if (ANALYSIS_KEYWORDS.test(text)) {
    score += 1;
  }
  if (MATH_KEYWORDS.test(text)) {
    score += 2;
  }
  if (MULTI_STEP.test(text)) {
    score += 1;
  }
  if (CREATIVE_KEYWORDS.test(text)) {
    score += 1;
  }

  const tokens = estimateTokens(text);
  if (tokens > 5000) {
    score += 2;
  } else if (tokens > 2000) {
    score += 1;
  }

  return score;
}

/**
 * Classify the complexity of a set of messages for model routing.
 *
 * Pure function with zero side-effects — safe to call on every LLM invocation.
 */
export function classifyComplexity(
  messages: unknown[],
  thresholds?: { moderate?: number; complex?: number },
): ComplexityLevel {
  if (!messages || messages.length === 0) {
    return "simple";
  }

  const moderateThreshold = thresholds?.moderate ?? 2;
  const complexThreshold = thresholds?.complex ?? 4;
  const score = scoreMessages(messages);

  if (score >= complexThreshold) {
    return "complex";
  }
  if (score >= moderateThreshold) {
    return "moderate";
  }
  return "simple";
}
