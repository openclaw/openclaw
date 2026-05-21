/**
 * Pure bridge: computes a memory-write judgment at post-compaction time.
 *
 * Does NOT write to any file. Returns a MemoryJudgmentResult (or undefined
 * when no task state is present) so callers can decide what to do with it.
 * A future writer path can consume the result and persist to the workspace
 * memory file once a safe, tested writer exists.
 *
 * Design: keep this import-free from heavy runtime deps so it can be used
 * from compaction-hooks.ts without introducing new import cycles.
 */

import { judgeMemoryWrite, type MemoryJudgmentResult } from "./agent-memory-judgment.js";
import type { AgentTaskState } from "./agent-task-state.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Optional memory-signal overrides a caller can supply at compaction time.
 * All fields are optional — absence of a field is treated as "no signal".
 */
export type PostCompactionMemorySignals = {
  /** Whether the user explicitly asked to remember or save this workflow. */
  userRequestedMemory?: boolean;
  /** Whether a new reusable workflow or procedure was established. */
  hasReusableWorkflow?: boolean;
  /** Whether a user preference was discovered or confirmed. */
  hasUserPreference?: boolean;
  /** Whether there are pending follow-up actions the user will want later. */
  hasPendingFollowUp?: boolean;
  /** Whether a significant project state change occurred. */
  hasProjectStateChange?: boolean;
  /**
   * Whether the task involved sensitive credentials, PII, or private data.
   * True forces `write: false` regardless of other signals.
   */
  involvesSensitiveData?: boolean;
  /** Whether the task ran inside a group/public channel context. */
  isGroupContext?: boolean;
};

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

/**
 * Compute a memory-write judgment from the compaction-time task state and
 * optional caller-supplied signals.
 *
 * Returns `undefined` when no task state is present (backcompat: no judgment,
 * no write). Never throws.
 */
export function buildPostCompactionMemoryJudgment(params: {
  taskState?: AgentTaskState;
  signals?: PostCompactionMemorySignals;
}): MemoryJudgmentResult | undefined {
  if (!params.taskState) {
    return undefined;
  }
  try {
    return judgeMemoryWrite({
      task: params.taskState,
      userRequestedMemory: params.signals?.userRequestedMemory,
      hasReusableWorkflow: params.signals?.hasReusableWorkflow,
      hasUserPreference: params.signals?.hasUserPreference,
      hasPendingFollowUp: params.signals?.hasPendingFollowUp,
      hasProjectStateChange: params.signals?.hasProjectStateChange,
      involvesSensitiveData: params.signals?.involvesSensitiveData,
      isGroupContext: params.signals?.isGroupContext,
    });
  } catch {
    return undefined;
  }
}
