import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  ChildState,
  NativeDescendantCancellation,
  ParentOwner,
  ParentState,
} from "./native-subagent-monitor-types.js";

export function captureNativeCancellationChildren(
  children: Iterable<ChildState>,
  states: readonly ParentState[],
  params: NativeDescendantCancellation,
  matchesOwner: (owner: ParentOwner) => boolean,
) {
  // A reused Codex parent keeps its original persistence locator. Prefer the
  // live execution owner for later generations, and retain that proof through
  // interruption because terminal handling releases the owner before settle.
  const selectedOwnerChildren = new Set<ChildState>();
  const matchesGeneration = (child: ChildState) => {
    const owner = child.modelExecution?.owner ?? child.directOwner;
    const matches =
      (child.historyOwner?.sessionId === params.sessionId &&
        child.historyOwner?.lifecycleRevision === params.lifecycleRevision) ||
      Boolean(owner && matchesOwner(owner));
    if (owner && matches && matchesOwner(owner)) {
      selectedOwnerChildren.add(child);
    }
    return matches;
  };
  return {
    matches: (child: ChildState) => matchesGeneration(child) || selectedOwnerChildren.has(child),
    selected: [...children].filter(
      (child) =>
        matchesGeneration(child) &&
        states.some((state) => state.parentThreadId === child.parentThreadId) &&
        params.acceptsRequest(child.requestCustody),
    ),
  };
}

/** Capture exact requester selection before reserving or cancelling any descendants. */
export function captureNativeCancellationSelection(
  parent: ParentState | undefined,
  parentStates: Iterable<ParentState>,
  childStates: Iterable<ChildState>,
  params: NativeDescendantCancellation,
) {
  const states = [...parentStates];
  const children = [...childStates];
  const matchesOwner = (owner: ParentOwner) =>
    owner.requesterAgentId === params.agentId &&
    owner.requesterSessionKey === params.sessionKey &&
    owner.requesterSessionId === params.sessionId &&
    owner.requesterLifecycleRevision === params.lifecycleRevision &&
    params.acceptsRequest(owner.requestCustody);
  if (!parent) {
    return { matchesOwner, matches: () => false, states: [] };
  }
  const selectedOwners = new Map<ParentState, ParentOwner>();
  const stableOwners = new Set<ParentOwner>();
  for (const state of states) {
    // Parent state can outlive the run that created its history locator. A
    // currently admitted owner is the authoritative generation in that case.
    const owner = [...state.owners.values()].find(matchesOwner);
    if (owner) {
      selectedOwners.set(state, owner);
      stableOwners.add(owner);
      continue;
    }
    const pendingOwner = [...(state.pendingRegistrations ?? [])].find(matchesOwner);
    if (pendingOwner) {
      selectedOwners.set(state, pendingOwner);
    }
  }
  const statesByThreadId = new Map(states.map((state) => [state.parentThreadId, state]));
  for (const child of children) {
    const owner = child.modelExecution?.owner ?? child.directOwner;
    const state = statesByThreadId.get(child.parentThreadId);
    if (state && owner && matchesOwner(owner) && params.acceptsRequest(child.requestCustody)) {
      selectedOwners.set(state, owner);
      stableOwners.add(owner);
    }
  }
  const hasSelectedOwner = (state: ParentState) => {
    const owner = selectedOwners.get(state);
    return Boolean(
      owner &&
      matchesOwner(owner) &&
      (stableOwners.has(owner) ||
        state.pendingRegistrations?.has(owner) ||
        owner.descendantsCancelled),
    );
  };
  const matches = (state: ParentState) => {
    if (state.agentId || state.historyOwner) {
      return (
        (state.agentId === params.agentId &&
          state.requesterSessionKey === params.sessionKey &&
          state.historyOwner?.sessionId === params.sessionId &&
          state.historyOwner?.lifecycleRevision === params.lifecycleRevision) ||
        hasSelectedOwner(state)
      );
    }
    return state.preparing === true && hasSelectedOwner(state);
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
