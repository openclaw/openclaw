import { matchCustomPhrase } from "./custom-phrases.ts";
import type {
  SmartHandlerConfig,
  ExecutionIntent,
  ExecutionKind,
  ScoredResult,
  MessageClassification,
  ConfidenceLevel,
  ModelTier,
} from "./types.ts";
import { SCORING_RULES, CHAT_PATTERNS, TASK_PATTERNS, TIE_BREAK_PRIORITY } from "./types.ts";

/**
 * Strip code fences, inline code, and blockquotes from a message.
 */
export function stripCodeAndQuotes(message: string): string {
  let result = message;
  // Remove fenced code blocks
  result = result.replace(/```[\s\S]*?```/g, "");
  // Remove inline code
  result = result.replace(/`[^`]+`/g, "");
  // Remove blockquotes
  result = result.replace(/(^|\n)>\s?[^\n]*/g, "");
  return result.trim();
}

/**
 * Position multiplier: keywords near the front weigh more.
 * Front 30% -> 1.5x, middle 40% -> 1.0x, back 30% -> 0.8x
 */
export function positionMultiplier(matchIndex: number, messageLength: number): number {
  if (messageLength === 0) {
    return 1.0;
  }
  const ratio = matchIndex / messageLength;
  if (ratio < 0.3) {
    return 1.5;
  }
  if (ratio > 0.7) {
    return 0.8;
  }
  return 1.0;
}

/**
 * Score a message against all execution kinds. Returns sorted results (highest first).
 */
export function scoreMessage(stripped: string, raw: string): ScoredResult[] {
  const lower = stripped.toLowerCase();
  const results: ScoredResult[] = [];

  for (const [kind, rule] of Object.entries(SCORING_RULES)) {
    let totalScore = 0;
    const breakdown: { term: string; contribution: number }[] = [];

    // Track matched spans to suppress substring double-counting
    const matchedSpans: { start: number; end: number }[] = [];

    // Sort keywords longest-first so longer matches claim spans before shorter substrings
    const sortedKws = [...rule.keywords].toSorted((a, b) => b.term.length - a.term.length);

    for (const kw of sortedKws) {
      const termLower = kw.term.toLowerCase();
      const idx = lower.indexOf(termLower);
      if (idx !== -1) {
        const end = idx + termLower.length;
        // Skip if this match is fully covered by a longer match
        const covered = matchedSpans.some((span) => idx >= span.start && end <= span.end);
        if (covered) {
          continue;
        }

        matchedSpans.push({ start: idx, end });
        const multiplier = positionMultiplier(idx, lower.length);
        const contribution = kw.weight * multiplier;
        totalScore += contribution;
        breakdown.push({ term: kw.term, contribution });
      }
    }

    // Only apply context bonuses if at least one keyword matched
    if (totalScore > 0) {
      for (const cb of rule.contextBonuses) {
        if (cb.test(stripped, raw)) {
          totalScore += cb.bonus;
          breakdown.push({ term: `[ctx:${cb.label}]`, contribution: cb.bonus });
        }
      }
    }

    results.push({ kind: kind as ExecutionKind, score: totalScore, breakdown });
  }

  return results.toSorted((a, b) => b.score - a.score);
}

/**
 * Break ties using the priority list.
 */
export function resolveTie(candidates: ScoredResult[]): ScoredResult {
  if (candidates.length === 0) {
    return { kind: "unknown", score: 0, breakdown: [] };
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  const topScore = candidates[0].score;
  const tied = candidates.filter((c) => c.score === topScore);
  if (tied.length === 1) {
    return tied[0];
  }

  // Use priority list for tie-breaking
  for (const priorityKind of TIE_BREAK_PRIORITY) {
    const match = tied.find((c) => c.kind === priorityKind);
    if (match) {
      return match;
    }
  }

  return tied[0];
}

/**
 * Check if a message appears to be incomplete
 */
export function isIncomplete(message: string, config: SmartHandlerConfig): boolean {
  const trimmed = message.trim();

  // Too short to determine
  if (trimmed.length < config.minMessageLength) {
    return true;
  }

  // Check for incomplete signals
  for (const signal of config.incompleteSignals) {
    if (trimmed.endsWith(signal)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a message appears to be complete
 */
export function isComplete(message: string, config: SmartHandlerConfig): boolean {
  const trimmed = message.trim();

  // Check for complete signals
  for (const signal of config.completeSignals) {
    if (trimmed.endsWith(signal)) {
      return true;
    }
  }

  return false;
}

/**
 * Classify execution intent from message content.
 */
export function classifyExecutionIntent(
  message: string,
  config: SmartHandlerConfig,
): ExecutionIntent {
  // Defense-in-depth: truncate input to prevent regex backtracking on adversarial messages
  const truncated = message.length > 2000 ? message.slice(0, 2000) : message;
  const input_finalized = isComplete(truncated, config);
  const trimmed = truncated.trim();
  const execution_expected = input_finalized && trimmed.length >= config.minMessageLength;

  const stripped = stripCodeAndQuotes(trimmed);

  // Priority 1: Custom user phrases
  const customMatch = matchCustomPhrase(truncated, config);
  if (customMatch) {
    return {
      input_finalized,
      execution_expected,
      execution_kind: customMatch.kind,
    };
  }

  // Check chat patterns first on the stripped text
  const isChatPattern = CHAT_PATTERNS.some((pattern) => pattern.test(stripped));
  if (isChatPattern) {
    return {
      input_finalized,
      execution_expected,
      execution_kind: "chat",
    };
  }

  // Score all kinds
  const scored = scoreMessage(stripped, trimmed);
  const winner = resolveTie(scored);

  let execution_kind: ExecutionKind;
  if (winner.score > config.scoreThreshold) {
    execution_kind = winner.kind;
  } else if (execution_expected) {
    // Below threshold but input is finalized — check if task patterns match
    const hasTaskPattern = TASK_PATTERNS.some((pattern) => pattern.test(stripped));
    execution_kind = hasTaskPattern ? "run" : "unknown";
  } else {
    execution_kind = "unknown";
  }

  // Chat/task conflict resolution: if scored as chat but task patterns match, override
  if (execution_kind === "chat") {
    const hasTaskPattern = TASK_PATTERNS.some((pattern) => pattern.test(stripped));
    if (hasTaskPattern) {
      // Re-score without chat, pick next best
      const nonChat = scored.filter((s) => s.kind !== "chat");
      const nextBest = resolveTie(nonChat);
      if (nextBest.score > config.scoreThreshold) {
        execution_kind = nextBest.kind;
      } else {
        execution_kind = "run";
      }
    }
  }

  return {
    input_finalized,
    execution_expected,
    execution_kind,
  };
}

const TIER_MAP: Record<ExecutionKind, ModelTier> = {
  chat: "fast",
  unknown: "fast",
  search: "standard",
  read: "standard",
  analyze: "standard",
  install: "premium",
  run: "premium",
  write: "premium",
  debug: "premium",
};

/**
 * Convert an ExecutionIntent + score into a full MessageClassification.
 */
export function toMessageClassification(
  intent: ExecutionIntent,
  score: number,
  config: SmartHandlerConfig,
): MessageClassification {
  const threshold = config.scoreThreshold;
  const confidence: ConfidenceLevel =
    score >= threshold * 2 ? "high" : score >= threshold ? "medium" : "low";

  return {
    kind: intent.execution_kind,
    confidence,
    input_finalized: intent.input_finalized,
    execution_expected: intent.execution_expected,
    suggested_tier: TIER_MAP[intent.execution_kind],
    classifier_version: "2.0-weighted",
    score,
  };
}

/**
 * Classify a message and return a full MessageClassification.
 * Combines classifyExecutionIntent logic with score tracking.
 */
export function classifyMessage(
  message: string,
  config: SmartHandlerConfig,
): MessageClassification {
  const truncated = message.length > 2000 ? message.slice(0, 2000) : message;
  const input_finalized = isComplete(truncated, config);
  const trimmed = truncated.trim();
  const execution_expected = input_finalized && trimmed.length >= config.minMessageLength;

  const stripped = stripCodeAndQuotes(trimmed);

  // Priority 1: Custom user phrases
  const customMatch = matchCustomPhrase(truncated, config);
  if (customMatch) {
    const intent: ExecutionIntent = {
      input_finalized,
      execution_expected,
      execution_kind: customMatch.kind,
    };
    // Custom phrase match gets a high synthetic score
    return toMessageClassification(intent, config.scoreThreshold * 2, config);
  }

  // Check chat patterns first on the stripped text
  const isChatPattern = CHAT_PATTERNS.some((pattern) => pattern.test(stripped));
  if (isChatPattern) {
    const intent: ExecutionIntent = {
      input_finalized,
      execution_expected,
      execution_kind: "chat",
    };
    return toMessageClassification(intent, 0, config);
  }

  // Score all kinds
  const scored = scoreMessage(stripped, trimmed);
  const winner = resolveTie(scored);
  let topScore = winner.score;

  let execution_kind: ExecutionKind;
  if (winner.score > config.scoreThreshold) {
    execution_kind = winner.kind;
  } else if (execution_expected) {
    const hasTaskPattern = TASK_PATTERNS.some((pattern) => pattern.test(stripped));
    execution_kind = hasTaskPattern ? "run" : "unknown";
  } else {
    execution_kind = "unknown";
  }

  // Chat/task conflict resolution
  if (execution_kind === "chat") {
    const hasTaskPattern = TASK_PATTERNS.some((pattern) => pattern.test(stripped));
    if (hasTaskPattern) {
      const nonChat = scored.filter((s) => s.kind !== "chat");
      const nextBest = resolveTie(nonChat);
      if (nextBest.score > config.scoreThreshold) {
        execution_kind = nextBest.kind;
        topScore = nextBest.score;
      } else {
        execution_kind = "run";
        topScore = nextBest.score;
      }
    }
  }

  const intent: ExecutionIntent = {
    input_finalized,
    execution_expected,
    execution_kind,
  };
  return toMessageClassification(intent, topScore, config);
}
