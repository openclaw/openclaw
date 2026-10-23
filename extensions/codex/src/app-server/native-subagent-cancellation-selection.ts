import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  NativeDescendantCancellation,
  ParentOwner,
  ParentState,
} from "./native-subagent-monitor-types.js";

/** Capture exact requester selection before reserving or cancelling any descendants. */
export function captureNativeCancellationSelection(
  parent: ParentState,
  parentStates: Iterable<ParentState>,
  params: NativeDescendantCancellation,
) {
  const states = [...parentStates];
  const matchesOwner = (owner: ParentOwner) =>
    owner.requesterAgentId === params.agentId &&
    owner.requesterSessionKey === params.sessionKey &&
    owner.requesterSessionId === params.sessionId &&
    owner.requesterLifecycleRevision === params.lifecycleRevision &&
    params.acceptsRequest(owner.requestCustody);
  const preparingOwners = new Map<ParentState, ParentOwner>();
  for (const state of states) {
    if (state.preparing && !state.agentId && !state.historyOwner) {
      const owner = [...(state.pendingRegistrations ?? [])].find(matchesOwner);
      if (owner) {
        preparingOwners.set(state, owner);
      }
    }
  }
  const matches = (state: ParentState) => {
    if (state.agentId || state.historyOwner) {
      return (
        state.agentId === params.agentId &&
        state.requesterSessionKey === params.sessionKey &&
        state.historyOwner?.sessionId === params.sessionId &&
        state.historyOwner?.lifecycleRevision === params.lifecycleRevision
      );
    }
    const owner = preparingOwners.get(state);
    return Boolean(
      state.preparing &&
      owner &&
      matchesOwner(owner) &&
      (state.pendingRegistrations?.has(owner) || owner.descendantsCancelled),
    );
  };
  if (!matches(parent)) {
    // Describe the failed boundary without logging requester identities or authority.
    embeddedAgentLog.warn("Codex descendant cancellation requester generation mismatch", {
      agentMatches: parent.agentId === params.agentId,
      sessionKeyMatches: parent.requesterSessionKey === params.sessionKey,
      sessionIdMatches: parent.historyOwner?.sessionId === params.sessionId,
      lifecycleMatches: parent.historyOwner?.lifecycleRevision === params.lifecycleRevision,
      registeredHistoryPresent: parent.historyOwner !== undefined,
      registeredLifecyclePresent: parent.historyOwner?.lifecycleRevision !== undefined,
      requestedLifecyclePresent: params.lifecycleRevision !== undefined,
      preparing: parent.preparing === true,
      activeOwnerCount: parent.owners.size,
      pendingOwnerCount: parent.pendingRegistrations?.size ?? 0,
    });
    throw new Error("Codex descendant cancellation requester generation changed");
  }
  return { matchesOwner, matches, states: states.filter(matches) };
}
