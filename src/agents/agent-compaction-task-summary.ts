/**
 * Pure bridge: converts an optional AgentTaskState into a formatted compaction
 * task summary string, ready to be included in the continuation prompt.
 *
 * Called from compaction-hooks.ts before the after_compaction hook fires.
 * Zero runtime dependencies — safe to import from any layer without cycles.
 *
 * Learned from: Claude Code compact.rs (get_compact_continuation_message) and
 * the agent architecture doc's Section 9 field requirements.
 */

import {
  buildCompactSummaryFromTask,
  formatCompactSummary,
  getCompactContinuationMessage,
} from "./agent-compact-summary.js";
import type { AgentTaskState } from "./agent-task-state.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Optional extra metadata that callers can supply alongside the task state.
 * Mirrors the extra fields accepted by `buildCompactSummaryFromTask`.
 */
export type CompactionTaskSummaryExtra = {
  /** Tool calls made during this run and their key outcomes. */
  tools_used?: Array<{ tool: string; summary: string }>;
  /** Most important facts gathered. */
  key_findings?: string[];
  /** Override the default next-step (first pending step or "No pending steps."). */
  next_step?: string;
  /** Hard user constraints to preserve across compaction. */
  user_constraints?: string[];
  /**
   * Set to true when recent messages are preserved in the compacted session;
   * the continuation message will note this to the model.
   */
  hasRecentMessages?: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the formatted continuation-prompt text from an AgentTaskState.
 *
 * Returns the full continuation message (XML summary block + resume directive),
 * which can be included in the compaction hook event payload or returned to
 * callers for injection into custom instructions.
 *
 * Never throws — any error during formatting returns an empty string.
 */
export function buildCompactionTaskSummary(
  task: AgentTaskState,
  extra?: CompactionTaskSummaryExtra,
): string {
  try {
    const fields = buildCompactSummaryFromTask(task, extra);
    const summaryText = formatCompactSummary(fields);
    return getCompactContinuationMessage({
      summary: summaryText,
      hasRecentMessages: extra?.hasRecentMessages ?? false,
    });
  } catch {
    return "";
  }
}

/**
 * Null-safe wrapper: returns `undefined` when no task state is provided or
 * when the formatted result is empty. Safe to call unconditionally from hook
 * machinery where task state is optional.
 */
export function buildCompactionTaskSummaryIfPresent(
  taskState: AgentTaskState | undefined,
  extra?: CompactionTaskSummaryExtra,
): string | undefined {
  if (!taskState) {
    return undefined;
  }
  const result = buildCompactionTaskSummary(taskState, extra);
  return result || undefined;
}
