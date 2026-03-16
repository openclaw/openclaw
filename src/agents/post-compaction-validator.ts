import type { SessionGuardSignal } from "./compaction-guard.js";

export type PostCompactionValidation = {
  ok: boolean;
  reasons: string[];
  shouldRecommendReset: boolean;
};

export type PostCompactionValidationInput = {
  signalBefore: SessionGuardSignal;
  compactionCountBefore?: number;
  compactionCountAfter?: number;
  summaryText?: string;
  projectedUsageRatioAfter?: number;
  latestUserGoal?: string;
  unresolvedItems?: string[];
};

const REASONS = {
  latestUserGoalMissing: "latest-user-goal-missing",
  pendingItemsMissing: "pending-items-missing",
  staleSystemPromoted: "stale-system-promoted",
  failurePatternNotCollapsed: "failure-pattern-not-collapsed",
  compactionCountNotIncremented: "compaction-count-not-incremented",
  usageNotImproved: "usage-not-improved",
} as const;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "then",
  "this",
  "to",
  "was",
  "were",
  "with",
]);

const ACTIVE_DIRECTIVE_MARKERS = [
  "always",
  "must",
  "remember to",
  "continue to",
  "keep",
  "do not",
  "dont",
  "never",
  "ensure",
];

const STALE_CONTEXT_MARKERS = [
  "system reminder",
  "system directive",
  "system instruction",
  "prior instruction",
  "previous instruction",
  "earlier instruction",
  "reminder",
  "directive",
  "instruction",
];

const COLLAPSE_CONTEXT_MARKERS = [
  "collapsed",
  "summarized",
  "summary",
  "ignored",
  "discarded",
  "duplicate reminder",
  "repeated reminder",
  "reminder loop",
  "directive loop",
];

const FAILURE_COLLAPSE_MARKERS = [
  "repeated tool failure",
  "repeated tool failures",
  "multiple tool failures",
  "failure pattern",
  "failure loop",
  "summarized failure",
  "summarized failures",
  "collapsed failure",
  "collapsed failures",
];

const FAILURE_LINE_MARKERS = [
  "error",
  "failed",
  "failure",
  "exception",
  "timeout",
  "stderr",
  "exit code",
  "traceback",
  "enoent",
  "rate limit",
  "rpc",
];

export function validatePostCompaction(
  input: PostCompactionValidationInput,
): PostCompactionValidation {
  const reasons: string[] = [];
  const normalizedSummary = normalizeText(input.summaryText ?? "");

  if (
    hasMeaningfulText(input.latestUserGoal) &&
    !isReflectedInSummary(input.latestUserGoal, normalizedSummary)
  ) {
    reasons.push(REASONS.latestUserGoalMissing);
  }

  if (
    (input.unresolvedItems ?? [])
      .filter(hasMeaningfulText)
      .some((item) => !isReflectedInSummary(item, normalizedSummary))
  ) {
    reasons.push(REASONS.pendingItemsMissing);
  }

  if (
    input.signalBefore.staleSystemRecurrences > 0 &&
    looksLikeActiveStaleDirective(normalizedSummary)
  ) {
    reasons.push(REASONS.staleSystemPromoted);
  }

  if (
    hadRepeatedFailuresBefore(input.signalBefore) &&
    looksLikeRawFailureChatter(input.summaryText ?? "")
  ) {
    reasons.push(REASONS.failurePatternNotCollapsed);
  }

  const compactionIncremented = didCompactionCountIncrease(
    input.compactionCountBefore,
    input.compactionCountAfter,
  );
  const usageImproved = didUsageImprove(
    input.projectedUsageRatioAfter,
    input.signalBefore.usageRatio,
  );

  if (!compactionIncremented && !usageImproved) {
    reasons.push(REASONS.compactionCountNotIncremented, REASONS.usageNotImproved);
  }

  const ok = reasons.length === 0;

  return {
    ok,
    reasons,
    shouldRecommendReset: !ok && shouldEscalateToReset(input.signalBefore),
  };
}

function hasMeaningfulText(value?: string): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeText(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `.replace(/\s+/g, " ");
}

function tokenizeMeaningfully(text: string): string[] {
  return [...new Set(normalizeText(text).trim().split(" ").filter(isMeaningfulToken))];
}

function isMeaningfulToken(token: string): boolean {
  return token.length >= 3 && !STOP_WORDS.has(token);
}

function isReflectedInSummary(sourceText: string, normalizedSummary: string): boolean {
  const normalizedSource = normalizeText(sourceText);

  if (!normalizedSource.trim()) {
    return true;
  }

  if (normalizedSummary.includes(normalizedSource)) {
    return true;
  }

  const sourceTokens = tokenizeMeaningfully(sourceText);

  if (sourceTokens.length === 0) {
    return false;
  }

  const summaryTokens = new Set(normalizedSummary.trim().split(" ").filter(Boolean));
  const matchedTokens = sourceTokens.filter((token) => summaryTokens.has(token)).length;
  const requiredMatches =
    sourceTokens.length <= 2
      ? sourceTokens.length
      : Math.max(2, Math.ceil(sourceTokens.length * 0.6));

  return matchedTokens >= requiredMatches;
}

function looksLikeActiveStaleDirective(normalizedSummary: string): boolean {
  if (!normalizedSummary.trim()) {
    return false;
  }

  return (
    includesAnyPhrase(normalizedSummary, STALE_CONTEXT_MARKERS) &&
    includesAnyPhrase(normalizedSummary, ACTIVE_DIRECTIVE_MARKERS) &&
    !includesAnyPhrase(normalizedSummary, COLLAPSE_CONTEXT_MARKERS)
  );
}

function includesAnyPhrase(text: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => text.includes(normalizeText(phrase)));
}

function hadRepeatedFailuresBefore(signal: SessionGuardSignal): boolean {
  return signal.repeatedToolFailures.some((failure) => failure.count > 1);
}

function looksLikeRawFailureChatter(summaryText: string): boolean {
  if (!hasMeaningfulText(summaryText)) {
    return false;
  }

  const normalizedSummary = normalizeText(summaryText);

  if (includesAnyPhrase(normalizedSummary, FAILURE_COLLAPSE_MARKERS)) {
    return false;
  }

  const rawFailureLineCount = summaryText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(looksLikeRawFailureLine).length;

  if (rawFailureLineCount >= 2) {
    return true;
  }

  const repeatedFailureMarkerCount = FAILURE_LINE_MARKERS.reduce(
    (count, marker) => count + countOccurrences(normalizedSummary, normalizeText(marker).trim()),
    0,
  );

  return repeatedFailureMarkerCount >= 3;
}

function looksLikeRawFailureLine(line: string): boolean {
  const normalizedLine = normalizeText(line);

  return (
    includesAnyPhrase(normalizedLine, FAILURE_LINE_MARKERS) &&
    (line.includes(":") ||
      /exit code \d+/.test(normalizedLine) ||
      normalizedLine.includes("stderr") ||
      normalizedLine.includes("traceback"))
  );
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  return text.split(needle).length - 1;
}

function didCompactionCountIncrease(before?: number, after?: number): boolean {
  return typeof after === "number" && after > (before ?? 0);
}

function didUsageImprove(projectedAfter?: number, before?: number): boolean {
  return (
    typeof projectedAfter === "number" && typeof before === "number" && projectedAfter < before
  );
}

function shouldEscalateToReset(signal: SessionGuardSignal): boolean {
  return (
    signal.action === "recommend-reset" || signal.action === "reset-candidate" || signal.score >= 8
  );
}
