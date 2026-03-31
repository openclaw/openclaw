/**
 * Heuristic task complexity classifier.
 *
 * Analyzes an incoming user message and returns a complexity tier
 * that can be used to inform model routing decisions.
 *
 * Tiers:
 *   - trivial:  Simple lookups, greetings, short factual questions
 *   - simple:   Single-step tasks, summaries, basic translations
 *   - moderate: Multi-step reasoning, document analysis, basic coding
 *   - complex:  Architecture design, complex debugging, multi-file refactors
 *   - expert:   Research synthesis, novel algorithm design, comprehensive reports
 */

export type ComplexityTier = "trivial" | "simple" | "moderate" | "complex" | "expert";

export type ClassificationResult = {
  tier: ComplexityTier;
  score: number; // 0-100
  signals: string[];
};

// Word count thresholds
const SHORT_MESSAGE = 20;
const MEDIUM_MESSAGE = 80;
const LONG_MESSAGE = 200;
const VERY_LONG_MESSAGE = 500;

// Patterns indicating higher complexity
const COMPLEX_PATTERNS: Array<{ pattern: RegExp; weight: number; signal: string }> = [
  // Architecture & design
  { pattern: /\b(architect|design|system|infrastructure|scalab)/i, weight: 12, signal: "architecture" },
  { pattern: /\b(refactor|restructur|reorganiz|overhaul)/i, weight: 10, signal: "refactoring" },
  { pattern: /\b(migrat|upgrad|convert|port)\b/i, weight: 8, signal: "migration" },

  // Deep analysis
  { pattern: /\b(analyz|investigat|debug|diagnos|troubleshoot)/i, weight: 10, signal: "analysis" },
  { pattern: /\b(comprehensive|thorough|detailed|in-depth|exhaustive)/i, weight: 8, signal: "depth" },
  { pattern: /\b(compar|evaluat|assess|benchmark|trade-?off)/i, weight: 7, signal: "evaluation" },

  // Code generation
  { pattern: /\b(implement|build|create|develop|write)\b.*\b(function|class|module|component|service|api)/i, weight: 8, signal: "code-gen" },
  { pattern: /\b(test|spec|coverage|unit test|integration test)/i, weight: 6, signal: "testing" },
  { pattern: /\b(optimize|performance|latency|throughput|memory)/i, weight: 7, signal: "optimization" },

  // Research & synthesis
  { pattern: /\b(research|study|literature|state of the art|survey)/i, weight: 10, signal: "research" },
  { pattern: /\b(report|document|whitepaper|proposal|specification)/i, weight: 8, signal: "document" },
  { pattern: /\b(strateg|roadmap|plan|approach|methodology)/i, weight: 7, signal: "planning" },

  // Multi-step indicators
  { pattern: /\b(step[- ]by[- ]step|first.*then|multiple.*steps)/i, weight: 6, signal: "multi-step" },
  { pattern: /\b(and also|additionally|furthermore|moreover)/i, weight: 3, signal: "compound" },

  // Code context
  { pattern: /```[\s\S]{100,}```/m, weight: 8, signal: "large-code-block" },
  { pattern: /\b(file|files|codebase|repository|repo)\b/i, weight: 4, signal: "codebase" },
];

// Patterns indicating lower complexity
const SIMPLE_PATTERNS: Array<{ pattern: RegExp; weight: number; signal: string }> = [
  { pattern: /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure)\b/i, weight: -15, signal: "greeting" },
  { pattern: /\b(what time|what date|what day|weather|temperature)\b/i, weight: -12, signal: "lookup" },
  { pattern: /\b(translate|convert)\b.{0,30}$/i, weight: -8, signal: "simple-convert" },
  { pattern: /\b(remind|timer|alarm|note)\b/i, weight: -6, signal: "utility" },
  { pattern: /^[^.!?]{0,50}[.!?]?\s*$/m, weight: -5, signal: "short-sentence" },
];

/**
 * Classify the complexity of a user message.
 */
export function classifyComplexity(message: string): ClassificationResult {
  const trimmed = message.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const signals: string[] = [];

  // Base score from message length
  let score = 30; // Start at moderate baseline

  if (wordCount <= SHORT_MESSAGE) {
    score -= 15;
    signals.push("short-message");
  } else if (wordCount <= MEDIUM_MESSAGE) {
    score += 5;
  } else if (wordCount <= LONG_MESSAGE) {
    score += 15;
    signals.push("detailed-message");
  } else if (wordCount <= VERY_LONG_MESSAGE) {
    score += 25;
    signals.push("very-detailed-message");
  } else {
    score += 35;
    signals.push("extensive-message");
  }

  // Apply complexity patterns
  for (const { pattern, weight, signal } of COMPLEX_PATTERNS) {
    if (pattern.test(trimmed)) {
      score += weight;
      signals.push(signal);
    }
  }

  // Apply simplicity patterns
  for (const { pattern, weight, signal } of SIMPLE_PATTERNS) {
    if (pattern.test(trimmed)) {
      score += weight; // weight is negative
      signals.push(signal);
    }
  }

  // Question mark count as minor complexity signal
  const questionMarks = (trimmed.match(/\?/g) ?? []).length;
  if (questionMarks > 2) {
    score += questionMarks * 2;
    signals.push("multi-question");
  }

  // Clamp score to 0-100
  score = Math.max(0, Math.min(100, score));

  // Map score to tier
  const tier = scoresToTier(score);

  return { tier, score, signals };
}

function scoresToTier(score: number): ComplexityTier {
  if (score < 15) return "trivial";
  if (score < 30) return "simple";
  if (score < 50) return "moderate";
  if (score < 75) return "complex";
  return "expert";
}

/**
 * Suggest optimal model tiers based on complexity.
 * Returns provider-agnostic tier suggestions.
 */
export function suggestModelTier(tier: ComplexityTier): {
  preferredTier: "cheap" | "balanced" | "premium";
  reasoning: string;
} {
  switch (tier) {
    case "trivial":
      return {
        preferredTier: "cheap",
        reasoning: "Simple lookup or greeting — fastest/cheapest model sufficient",
      };
    case "simple":
      return {
        preferredTier: "cheap",
        reasoning: "Single-step task — efficient model recommended",
      };
    case "moderate":
      return {
        preferredTier: "balanced",
        reasoning: "Multi-step reasoning required — balanced model recommended",
      };
    case "complex":
      return {
        preferredTier: "premium",
        reasoning: "Complex task requiring deep reasoning — premium model recommended",
      };
    case "expert":
      return {
        preferredTier: "premium",
        reasoning: "Expert-level synthesis required — best available model recommended",
      };
  }
}
