/**
 * Heuristic query complexity classifier for voice escalation routing.
 * Zero latency — no API calls, pure pattern matching.
 *
 * Routes ~10% of queries to a stronger model (Sonnet) when complexity
 * signals are detected. Simple greetings and short questions stay on Haiku.
 */

/** Complexity signals with weighted scores */
const COMPLEXITY_PATTERNS: Array<{ pattern: RegExp; weight: number; label: string }> = [
  // Multi-part questions
  { pattern: /\b(and also|additionally|furthermore|as well as|on top of that)\b/i, weight: 3, label: "multi-part" },
  { pattern: /\b(first|second|third|finally)\b.*\b(first|second|third|finally)\b/i, weight: 3, label: "enumerated" },
  { pattern: /\?.*\?/s, weight: 2, label: "multiple-questions" },

  // Comparison / analysis requests
  { pattern: /\b(compare|comparison|difference between|versus|vs\.?|pros and cons|trade.?offs?)\b/i, weight: 3, label: "comparison" },
  { pattern: /\b(analyze|analysis|evaluate|assessment|break down|breakdown)\b/i, weight: 2, label: "analysis" },
  { pattern: /\b(explain|walk me through|how does .{10,} work)\b/i, weight: 2, label: "explanation" },

  // Technical / domain complexity
  { pattern: /\b(contract|clause|liability|indemnif|compliance|regulat|fiduciary)\b/i, weight: 2, label: "legal" },
  { pattern: /\b(tax|deduction|depreciat|amortiz|capital gains|401k|ira|roth)\b/i, weight: 2, label: "financial" },
  { pattern: /\b(integrate|integration|api|database|migration|architect)\b/i, weight: 2, label: "technical" },

  // Strategy / planning
  { pattern: /\b(strategy|strategic|plan|planning|roadmap|timeline|budget|forecast)\b/i, weight: 2, label: "strategy" },
  { pattern: /\b(recommend|suggestion|advise|what should|what would you)\b/i, weight: 1, label: "recommendation" },

  // Conditional / hypothetical reasoning
  { pattern: /\b(what if|hypothetically|scenario|assuming|suppose)\b/i, weight: 2, label: "hypothetical" },
  { pattern: /\b(depends on|it depends|considering|taking into account)\b/i, weight: 1, label: "conditional" },
];

/** Patterns that indicate simple queries — reduce score */
const SIMPLICITY_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
  { pattern: /^(hi|hello|hey|good morning|good afternoon|good evening|thanks|thank you|bye|goodbye|yes|no|ok|okay|sure|got it|sounds good)\b/i, weight: -5 },
  { pattern: /\b(what time|what's your|do you have|is .{1,20} open|hours|location|address|phone number|website)\b/i, weight: -3 },
  { pattern: /\b(schedule|book|appointment|cancel|reschedule)\b/i, weight: -2 },
];

const COMPLEXITY_THRESHOLD = 3;

export type ComplexityResult = {
  level: "simple" | "complex";
  score: number;
  signals: string[];
};

/**
 * Classify a user message as simple or complex based on heuristics.
 * Returns the classification, score, and which signals matched.
 */
export function classifyQueryComplexity(
  message: string,
  conversationLength?: number,
): ComplexityResult {
  let score = 0;
  const signals: string[] = [];

  // Message length contributes to complexity
  if (message.length > 200) {
    score += 2;
    signals.push("long-message");
  } else if (message.length > 400) {
    score += 3;
    signals.push("very-long-message");
  }

  // Word count
  const wordCount = message.split(/\s+/).length;
  if (wordCount > 30) {
    score += 1;
    signals.push("high-word-count");
  }

  // Check complexity patterns
  for (const { pattern, weight, label } of COMPLEXITY_PATTERNS) {
    if (pattern.test(message)) {
      score += weight;
      signals.push(label);
    }
  }

  // Check simplicity patterns (reduce score)
  for (const { pattern, weight } of SIMPLICITY_PATTERNS) {
    if (pattern.test(message)) {
      score += weight; // weight is negative
    }
  }

  // Longer conversations are more likely to have built up context
  // that requires stronger reasoning
  if (conversationLength && conversationLength > 6) {
    score += 1;
    signals.push("long-conversation");
  }

  return {
    level: score >= COMPLEXITY_THRESHOLD ? "complex" : "simple",
    score,
    signals,
  };
}
