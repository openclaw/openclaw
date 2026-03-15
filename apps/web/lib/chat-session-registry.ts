export type ChatPanelRuntimeState = {
  sessionId: string | null;
  sessionKey: string | null;
  isStreaming: boolean;
  status: string;
  isReconnecting: boolean;
  loadingSession: boolean;
};

export type ChatTabRuntimeSnapshot = ChatPanelRuntimeState & {
  tabId: string;
};

export type ChatRunsSnapshot = {
  parentStatuses: Map<string, "running" | "waiting-for-subagents" | "completed" | "error">;
  subagentStatuses: Map<string, "running" | "completed" | "error">;
};

export function mergeChatRuntimeSnapshot(
  state: Record<string, ChatTabRuntimeSnapshot>,
  snapshot: ChatTabRuntimeSnapshot,
): Record<string, ChatTabRuntimeSnapshot> {
  const current = state[snapshot.tabId];
  if (
    current &&
    current.sessionId === snapshot.sessionId &&
    current.sessionKey === snapshot.sessionKey &&
    current.isStreaming === snapshot.isStreaming &&
    current.status === snapshot.status &&
    current.isReconnecting === snapshot.isReconnecting &&
    current.loadingSession === snapshot.loadingSession
  ) {
    return state;
  }
  return {
    ...state,
    [snapshot.tabId]: snapshot,
  };
}

export function removeChatRuntimeSnapshot(
  state: Record<string, ChatTabRuntimeSnapshot>,
  tabId: string,
): Record<string, ChatTabRuntimeSnapshot> {
  if (!(tabId in state)) {
    return state;
  }
  const next = { ...state };
  delete next[tabId];
  return next;
}

export function createChatRunsSnapshot(params: {
  parentRuns: Array<{ sessionId: string; status: "running" | "waiting-for-subagents" | "completed" | "error" }>;
  subagents: Array<{ childSessionKey: string; status: "running" | "completed" | "error" }>;
}): ChatRunsSnapshot {
  return {
    parentStatuses: new Map(params.parentRuns.map((run) => [run.sessionId, run.status])),
    subagentStatuses: new Map(params.subagents.map((run) => [run.childSessionKey, run.status])),
  };
}
