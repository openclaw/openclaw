/**
 * Phase 12: heartbeat task-progress prompt helper.
 *
 * Pure helper for surfacing a compact task progress line during heartbeat turns.
 * Default behaviour is unchanged: when no task state is supplied, callers get
 * undefined and should omit the contribution.
 */

import { renderMidTaskProgressLine } from "./agent-compact-summary.js";
import type { AgentTaskState } from "./agent-task-state.js";

export function buildHeartbeatTaskProgressLine(
  taskState: AgentTaskState | undefined,
): string | undefined {
  if (!taskState) {
    return undefined;
  }
  try {
    const line = renderMidTaskProgressLine(taskState).trim();
    return line ? line : undefined;
  } catch {
    return undefined;
  }
}

export function buildHeartbeatTaskProgressContext(
  taskState: AgentTaskState | undefined,
): string | undefined {
  const line = buildHeartbeatTaskProgressLine(taskState);
  if (!line) {
    return undefined;
  }
  return ["## Current Task Progress", line].join("\n");
}
