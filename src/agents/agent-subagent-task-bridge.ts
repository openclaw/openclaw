/**
 * Pure bridge helpers for wiring AgentTaskState across subagent spawn boundaries.
 *
 * Covers three moments in the lifecycle:
 *   1. Pre-spawn  — start the task and build a context string for the child prompt.
 *   2. Post-spawn — merge the SpawnSubagentResult back into the parent task state.
 *   3. Completion — complete the task after the subagent's reply is received.
 *
 * All helpers are pure (no I/O, no runtime imports) and serializable, so they
 * compose safely with any callers at any layer depth.
 *
 * Learned from: Claude Code session.rs task dispatch model (reference doc Section 11).
 */

import type { AgentTaskState } from "./agent-task-state.js";
import {
  advanceTaskStep,
  completeTask,
  failTask,
  recordTaskOutputs,
  renderTaskSummary,
  startTask,
} from "./agent-task-state.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal subset of SpawnSubagentResult needed for task state merging.
 * Kept narrow so callers can pass partial results without importing the full
 * spawn module (important for test isolation and import-cycle safety).
 */
export type SubagentResultForTaskMerge = {
  status: "accepted" | "forbidden" | "error";
  error?: string;
  childSessionKey?: string;
  runId?: string;
};

// ---------------------------------------------------------------------------
// Pre-spawn helpers
// ---------------------------------------------------------------------------

/**
 * Transition a task to "running" at the moment a subagent is dispatched.
 * Callers should persist the returned state and later call
 * `mergeSubagentResultIntoTask` to record the outcome.
 */
export function startTaskForSubagentSpawn(task: AgentTaskState): AgentTaskState {
  return startTask(task);
}

/**
 * Build the task context block to inject into the subagent's system prompt.
 * Orients the child agent about what parent task it is contributing to, without
 * leaking full task output state.
 */
export function buildTaskContextForChildPrompt(task: AgentTaskState): string {
  return `## Parent Task Context\n${renderTaskSummary(task)}`;
}

// ---------------------------------------------------------------------------
// Post-spawn merge
// ---------------------------------------------------------------------------

/**
 * Merge a subagent spawn result back into the parent task state.
 *
 * - `accepted`: advance the first pending step (subagent dispatched) and
 *   record `runId` / `childSessionKey` as task outputs for traceability.
 * - `error` or `forbidden`: fail the task and append the error reason to blockers.
 *
 * Pure function — does not touch the gateway or any external state.
 * Callers are responsible for persisting the returned task state.
 */
export function mergeSubagentResultIntoTask(
  task: AgentTaskState,
  result: SubagentResultForTaskMerge,
): AgentTaskState {
  if (result.status === "accepted") {
    let updated = advanceTaskStep(task);
    const dispatchOutputs: Record<string, unknown> = {};
    if (result.runId) {
      dispatchOutputs.subagentRunId = result.runId;
    }
    if (result.childSessionKey) {
      dispatchOutputs.subagentSessionKey = result.childSessionKey;
    }
    if (Object.keys(dispatchOutputs).length > 0) {
      updated = recordTaskOutputs(updated, dispatchOutputs);
    }
    return updated;
  }
  // "error" or "forbidden"
  const reason = result.error?.trim() || `subagent spawn ${result.status}`;
  return failTask(task, reason);
}

// ---------------------------------------------------------------------------
// Completion helper
// ---------------------------------------------------------------------------

/**
 * Complete the parent task after the subagent's reply has been received.
 * Alias for `completeTask` — provided as a named entry point so callers have
 * a single import for the full spawn-boundary task lifecycle.
 */
export const completeTaskAfterSubagent = completeTask;
