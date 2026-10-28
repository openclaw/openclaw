/** Host-only continuation of one yielded native task across a session-tool handoff. */
import { getLatestLiveSubagentRunByChildSessionKey } from "./subagent-registry-read.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const HANDOFF = Symbol("openclaw.subagentTaskHandoff");

/**
 * The exact registry row that was executing the yielding turn. Redemption adopts only this
 * row's pause, so a kill, reset, replacement or earlier resume leaves the event an ordinary
 * follow-up. Adoption replaces the row, which makes the binding single-use.
 */
export type SubagentTaskHandoff = Readonly<{ task: SubagentRunRecord }>;

const handoffs = new WeakMap<object, SubagentTaskHandoff>();

/** Captured at handoff time; only the live task execution itself, never a sibling follow-up. */
export function captureSubagentTaskHandoff(params: {
  sessionKey: string;
  agentId: string;
  runId: string | undefined;
}): SubagentTaskHandoff | undefined {
  const task =
    params.runId &&
    getLatestLiveSubagentRunByChildSessionKey(params.sessionKey, undefined, params.agentId);
  if (
    !task ||
    task.runId !== params.runId ||
    task.pauseReason ||
    task.killIntent ||
    task.killReconciliation ||
    typeof task.execution.endedAt === "number"
  ) {
    return undefined;
  }
  const handoff: SubagentTaskHandoff = Object.freeze({ task });
  handoffs.set(handoff, handoff);
  return handoff;
}

/** Ordinary context copies retain the binding; serialized or model-supplied data cannot. */
export function bindSubagentTaskHandoff(
  carrier: object,
  handoff: SubagentTaskHandoff | undefined,
): void {
  if (handoff && handoffs.has(handoff)) {
    Object.assign(carrier, { [HANDOFF]: handoff });
  }
}

export function readSubagentTaskHandoff(carrier: object): SubagentTaskHandoff | undefined {
  const value: unknown = Reflect.get(carrier, HANDOFF);
  return typeof value === "object" && value !== null ? handoffs.get(value) : undefined;
}
