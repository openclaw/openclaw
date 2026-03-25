import type { GuardAction, SessionGuardSignal } from "../compaction-guard.js";

/**
 * Compaction instruction utilities.
 *
 * Provides default language-preservation instructions and a precedence-based
 * resolver for customInstructions used during context compaction summaries.
 */

/**
 * Default instructions injected into every safeguard-mode compaction summary.
 * Preserves conversation language and persona while keeping the SDK's required
 * summary structure intact.
 */
export const DEFAULT_COMPACTION_INSTRUCTIONS =
  "Write the summary body in the primary language used in the conversation.\n" +
  "Focus on factual content: what was discussed, decisions made, and current state.\n" +
  "Keep the required summary structure and section headers unchanged.\n" +
  "Do not translate or alter code, file paths, identifiers, or error messages.";

/**
 * Upper bound on custom instruction length to prevent prompt bloat.
 * ~800 chars ≈ ~200 tokens — keeps summarization quality stable.
 */
const MAX_INSTRUCTION_LENGTH = 800;
const MAX_GUARD_FAILURE_PATTERNS = 3;
const GUARDED_COMPACTION_ACTIONS = new Set<GuardAction>([
  "compact",
  "recommend-reset",
  "reset-candidate",
]);

function truncateUnicodeSafe(s: string, maxCodePoints: number): string {
  const chars = Array.from(s);
  if (chars.length <= maxCodePoints) {
    return s;
  }
  return chars.slice(0, maxCodePoints).join("");
}

function normalize(s: string | undefined): string | undefined {
  if (s == null) {
    return undefined;
  }
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve compaction instructions with precedence:
 *   event (SDK) → runtime (config) → DEFAULT constant.
 *
 * Each input is normalized first (trim + empty→undefined) so that blank
 * strings don't short-circuit the fallback chain.
 */
export function resolveCompactionInstructions(
  eventInstructions: string | undefined,
  runtimeInstructions: string | undefined,
): string {
  const resolved =
    normalize(eventInstructions) ??
    normalize(runtimeInstructions) ??
    DEFAULT_COMPACTION_INSTRUCTIONS;
  return truncateUnicodeSafe(resolved, MAX_INSTRUCTION_LENGTH);
}

/**
 * Compose split-turn instructions by combining the SDK's turn-prefix
 * instructions with the resolved compaction instructions.
 */
export function composeSplitTurnInstructions(
  turnPrefixInstructions: string,
  resolvedInstructions: string,
): string {
  return [turnPrefixInstructions, "Additional requirements:", resolvedInstructions].join("\n\n");
}

function formatGuardUsageRatio(usageRatio: number): string | null {
  if (!Number.isFinite(usageRatio) || usageRatio <= 0) {
    return null;
  }
  return `- Context pressure before compaction: ${(usageRatio * 100).toFixed(1)}% of the window.`;
}

function formatGuardRepeatedFailures(
  repeatedToolFailures: SessionGuardSignal["repeatedToolFailures"],
): string[] {
  if (repeatedToolFailures.length === 0) {
    return [];
  }

  const lines = repeatedToolFailures
    .slice(0, MAX_GUARD_FAILURE_PATTERNS)
    .map(
      (failure) =>
        `- Repeated tool failure pattern: ${failure.signature} (count ${failure.count}).`,
    );

  if (repeatedToolFailures.length > MAX_GUARD_FAILURE_PATTERNS) {
    lines.push(
      `- Additional repeated tool failure patterns: ${
        repeatedToolFailures.length - MAX_GUARD_FAILURE_PATTERNS
      } more.`,
    );
  }

  return lines;
}

function buildGuardSignalLines(
  guardSignal: Pick<
    SessionGuardSignal,
    | "usageRatio"
    | "repeatedToolFailures"
    | "duplicateAssistantClusters"
    | "staleSystemRecurrences"
    | "noGroundedReplyTurns"
  >,
): string[] {
  const lines: string[] = [];
  const usageRatioLine = formatGuardUsageRatio(guardSignal.usageRatio);

  if (usageRatioLine) {
    lines.push(usageRatioLine);
  }

  lines.push(...formatGuardRepeatedFailures(guardSignal.repeatedToolFailures));

  if (guardSignal.duplicateAssistantClusters > 0) {
    lines.push(
      `- Duplicate assistant commentary clusters in the recent tail: ${guardSignal.duplicateAssistantClusters}.`,
    );
  }

  if (guardSignal.staleSystemRecurrences > 0) {
    lines.push(
      `- Repeated stale reminder/system entries in the recent tail: ${guardSignal.staleSystemRecurrences}.`,
    );
  }

  if (guardSignal.noGroundedReplyTurns > 0) {
    lines.push(
      `- Trailing user turns without a grounded assistant reply: ${guardSignal.noGroundedReplyTurns}.`,
    );
  }

  return lines;
}

export function buildGuardAugmentedCompactionInstructions(params: {
  baseInstructions: string;
  guardEnabled?: boolean;
  guardSignal?:
    | Pick<
        SessionGuardSignal,
        | "action"
        | "usageRatio"
        | "repeatedToolFailures"
        | "duplicateAssistantClusters"
        | "staleSystemRecurrences"
        | "noGroundedReplyTurns"
      >
    | undefined;
}): string {
  const { baseInstructions, guardEnabled, guardSignal } = params;

  if (
    guardEnabled !== true ||
    !guardSignal ||
    !GUARDED_COMPACTION_ACTIONS.has(guardSignal.action)
  ) {
    return baseInstructions;
  }

  const lines = [
    "Loop-aware compaction guard:",
    "Preserve, in priority order:",
    "1. The latest explicit user goal or request.",
    "2. Unresolved tasks, pending follow-through, and promises still owed to the user.",
    "3. Recent decisions, constraints, and user preferences that still govern the work.",
    "4. The latest meaningful assistant answer that directly addressed the user.",
    "Compress aggressively:",
    "- Repeated tool failures with the same signature.",
    "- Duplicate assistant commentary or status updates that do not add new facts.",
    "- Stale reminder/system text that was not reaffirmed by a recent user turn.",
    "Do not represent stale reminder/system text as an active user goal.",
    "If repeated failure patterns exist, summarize each pattern once with its count and latest reason.",
    ...buildGuardSignalLines(guardSignal),
  ];

  return `${baseInstructions}\n\n${lines.join("\n")}`;
}
