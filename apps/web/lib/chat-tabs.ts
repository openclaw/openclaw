import {
  type Tab,
  type TabState,
  generateTabId,
  openTab,
} from "./tab-state";

export function isChatTab(tab: Tab | undefined | null): tab is Tab {
  return tab?.type === "chat";
}

export function isSubagentChatTab(tab: Tab | undefined | null): tab is Tab {
  return Boolean(tab?.type === "chat" && tab.sessionKey);
}

export function createBlankChatTab(title = "New Chat"): Tab {
  return {
    id: generateTabId(),
    type: "chat",
    title,
  };
}

export function createParentChatTab(params: {
  sessionId: string;
  title?: string;
}): Tab {
  return {
    id: generateTabId(),
    type: "chat",
    title: params.title || "New Chat",
    sessionId: params.sessionId,
  };
}

export function createSubagentChatTab(params: {
  sessionKey: string;
  parentSessionId: string;
  title?: string;
}): Tab {
  return {
    id: generateTabId(),
    type: "chat",
    title: params.title || "Subagent",
    sessionKey: params.sessionKey,
    parentSessionId: params.parentSessionId,
  };
}

export function bindParentSessionToChatTab(
  state: TabState,
  tabId: string,
  sessionId: string | null,
): TabState {
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === tabId
        ? {
            ...tab,
            sessionId: sessionId ?? undefined,
            sessionKey: undefined,
          }
        : tab,
    ),
  };
}

export function updateChatTabTitle(
  state: TabState,
  tabId: string,
  title: string,
): TabState {
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === tabId && tab.title !== title
        ? { ...tab, title }
        : tab,
    ),
  };
}

export function syncParentChatTabTitles(
  state: TabState,
  sessions: Array<{ id: string; title: string }>,
): TabState {
  const titleBySessionId = new Map(sessions.map((session) => [session.id, session.title]));
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.type !== "chat" || !tab.sessionId) {
      return tab;
    }
    const nextTitle = titleBySessionId.get(tab.sessionId);
    if (!nextTitle || nextTitle === tab.title) {
      return tab;
    }
    changed = true;
    return { ...tab, title: nextTitle };
  });
  return changed ? { ...state, tabs } : state;
}

export function syncSubagentChatTabTitles(
  state: TabState,
  subagents: Array<{ childSessionKey: string; label?: string; task: string }>,
): TabState {
  const titleBySessionKey = new Map(
    subagents.map((subagent) => [subagent.childSessionKey, subagent.label || subagent.task]),
  );
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.type !== "chat" || !tab.sessionKey) {
      return tab;
    }
    const nextTitle = titleBySessionKey.get(tab.sessionKey);
    if (!nextTitle || nextTitle === tab.title) {
      return tab;
    }
    changed = true;
    return { ...tab, title: nextTitle };
  });
  return changed ? { ...state, tabs } : state;
}

export function openOrFocusParentChatTab(
  state: TabState,
  params: { sessionId: string; title?: string },
): TabState {
  return openTab(state, createParentChatTab(params));
}

export function openOrFocusSubagentChatTab(
  state: TabState,
  params: { sessionKey: string; parentSessionId: string; title?: string },
): TabState {
  return openTab(state, createSubagentChatTab(params));
}

export function closeChatTabsForSession(
  state: TabState,
  sessionId: string,
): TabState {
  const tabs = state.tabs.filter((tab) => {
    if (tab.pinned) {
      return true;
    }
    if (tab.type !== "chat") {
      return true;
    }
    return tab.sessionId !== sessionId && tab.parentSessionId !== sessionId;
  });

  const activeStillExists = tabs.some((tab) => tab.id === state.activeTabId);
  return {
    tabs,
    activeTabId: activeStillExists ? state.activeTabId : tabs[tabs.length - 1]?.id ?? null,
  };
}

export function createGatewayChatTab(params: {
  sessionKey: string;
  sessionId: string;
  channel: string;
  title?: string;
}): Tab {
  return {
    id: generateTabId(),
    type: "gateway-chat",
    title: params.title || "Channel Chat",
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    channel: params.channel,
  };
}

export function isGatewayChatTab(tab: Tab | undefined | null): tab is Tab {
  return tab?.type === "gateway-chat";
}

export function openOrFocusGatewayChatTab(
  state: TabState,
  params: { sessionKey: string; sessionId: string; channel: string; title?: string },
): TabState {
  return openTab(state, createGatewayChatTab(params));
}

export function resolveChatIdentityForTab(tab: Tab | undefined | null): {
  sessionId: string | null;
  subagentKey: string | null;
  gatewaySessionKey: string | null;
} {
  if (!tab) {
    return { sessionId: null, subagentKey: null, gatewaySessionKey: null };
  }
  if (tab.type === "gateway-chat") {
    return {
      sessionId: tab.sessionId ?? null,
      subagentKey: null,
      gatewaySessionKey: tab.sessionKey ?? null,
    };
  }
  if (tab.type !== "chat") {
    return { sessionId: null, subagentKey: null, gatewaySessionKey: null };
  }
  if (tab.sessionKey) {
    return {
      sessionId: tab.parentSessionId ?? null,
      subagentKey: tab.sessionKey,
      gatewaySessionKey: null,
    };
  }
  return {
    sessionId: tab.sessionId ?? null,
    subagentKey: null,
    gatewaySessionKey: null,
  };
}
