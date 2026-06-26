/** Shared classification for parent-visible lifecycle events. */

export type AgentLifecycleReplyEvent = {
  phase?: string;
  yielded?: boolean;
  livenessState?: string;
  stopReason?: string;
};

export type AgentLifecycleParentState =
  | { kind: "yielded_waiting" }
  | { kind: "terminal" }
  | { kind: "unknown" };

export function classifyAgentLifecycleParentState(
  event: AgentLifecycleReplyEvent,
): AgentLifecycleParentState {
  if (event.phase === "error") {
    return { kind: "terminal" };
  }
  if (event.yielded === true) {
    return { kind: "yielded_waiting" };
  }
  if (event.phase === "end") {
    return { kind: "terminal" };
  }
  return { kind: "unknown" };
}

export function isAgentLifecycleYieldedWaiting(event: AgentLifecycleReplyEvent): boolean {
  return classifyAgentLifecycleParentState(event).kind === "yielded_waiting";
}
