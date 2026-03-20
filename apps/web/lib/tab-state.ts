/**
 * Tab state management for the workspace.
 *
 * Tabs are stored in localStorage keyed per workspace.
 * The URL reflects only the active tab's content (backward compatible).
 */

export type TabType = "home" | "file" | "chat" | "app" | "object" | "cron" | "gateway-chat";

export const HOME_TAB_ID = "__home__";

export const HOME_TAB: Tab = {
  id: HOME_TAB_ID,
  type: "home",
  title: "Home",
  pinned: true,
};

export type Tab = {
  id: string;
  type: TabType;
  title: string;
  icon?: string;
  path?: string;
  sessionId?: string;
  sessionKey?: string;
  parentSessionId?: string;
  pinned?: boolean;
  /** Channel identifier for gateway-chat tabs (e.g. "telegram", "discord"). */
  channel?: string;
};

export type TabState = {
  tabs: Tab[];
  activeTabId: string | null;
};

const STORAGE_PREFIX = "dench:tabs";

function storageKey(workspaceId?: string | null): string {
  return `${STORAGE_PREFIX}:${workspaceId || "default"}`;
}

export function generateTabId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function ensureHomeTab(state: TabState): TabState {
  const hasHome = state.tabs.some((t) => t.id === HOME_TAB_ID);
  if (hasHome) {
    // Make sure home is always first
    const home = state.tabs.find((t) => t.id === HOME_TAB_ID)!;
    const rest = state.tabs.filter((t) => t.id !== HOME_TAB_ID);
    return { ...state, tabs: [home, ...rest] };
  }
  return {
    tabs: [HOME_TAB, ...state.tabs],
    activeTabId: state.activeTabId || HOME_TAB_ID,
  };
}

export function loadTabs(workspaceId?: string | null): TabState {
  if (typeof window === "undefined") return { tabs: [HOME_TAB], activeTabId: HOME_TAB_ID };
  try {
    const raw = localStorage.getItem(storageKey(workspaceId));
    if (!raw) return { tabs: [HOME_TAB], activeTabId: HOME_TAB_ID };
    const parsed = JSON.parse(raw) as TabState;
    if (!Array.isArray(parsed.tabs)) return { tabs: [HOME_TAB], activeTabId: HOME_TAB_ID };
    return ensureHomeTab(parsed);
  } catch {
    return { tabs: [HOME_TAB], activeTabId: HOME_TAB_ID };
  }
}

export function saveTabs(state: TabState, workspaceId?: string | null): void {
  if (typeof window === "undefined") return;
  try {
    const serializable: TabState = {
      tabs: state.tabs.map(({ id, type, title, icon, path, sessionId, sessionKey, parentSessionId, pinned }) => ({
        id, type, title, icon, path, sessionId, sessionKey, parentSessionId, pinned,
      })),
      activeTabId: state.activeTabId,
    };
    localStorage.setItem(storageKey(workspaceId), JSON.stringify(serializable));
  } catch {
    // localStorage full or unavailable
  }
}

export function findTabByPath(tabs: Tab[], path: string): Tab | undefined {
  return tabs.find((t) => t.path === path);
}

export function findTabBySessionId(tabs: Tab[], sessionId: string): Tab | undefined {
  return tabs.find((t) => t.type === "chat" && t.sessionId === sessionId);
}

export function findTabBySessionKey(tabs: Tab[], sessionKey: string): Tab | undefined {
  return tabs.find((t) => t.type === "chat" && t.sessionKey === sessionKey);
}

export function openTab(state: TabState, tab: Tab): TabState {
  const existing = tab.path
    ? findTabByPath(state.tabs, tab.path)
    : tab.sessionKey
      ? findTabBySessionKey(state.tabs, tab.sessionKey)
      : tab.sessionId
        ? findTabBySessionId(state.tabs, tab.sessionId)
        : undefined;

  if (existing) {
    return { ...state, activeTabId: existing.id };
  }

  return {
    tabs: [...state.tabs, tab],
    activeTabId: tab.id,
  };
}

export function closeTab(state: TabState, tabId: string): TabState {
  if (tabId === HOME_TAB_ID) return state;
  const idx = state.tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return state;
  if (state.tabs[idx].pinned) return state;

  const newTabs = state.tabs.filter((t) => t.id !== tabId);
  let newActiveId = state.activeTabId;

  if (state.activeTabId === tabId) {
    if (newTabs.length === 0) {
      newActiveId = null;
    } else if (idx < newTabs.length) {
      newActiveId = newTabs[idx].id;
    } else {
      newActiveId = newTabs[newTabs.length - 1].id;
    }
  }

  return { tabs: newTabs, activeTabId: newActiveId };
}

export function closeOtherTabs(state: TabState, tabId: string): TabState {
  const keep = state.tabs.filter((t) => t.id === tabId || t.pinned);
  return { tabs: keep, activeTabId: tabId };
}

export function closeTabsToRight(state: TabState, tabId: string): TabState {
  const idx = state.tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return state;
  const keep = state.tabs.filter((t, i) => i <= idx || t.pinned);
  const activeStillExists = keep.some((t) => t.id === state.activeTabId);
  return { tabs: keep, activeTabId: activeStillExists ? state.activeTabId : tabId };
}

export function closeAllTabs(state: TabState): TabState {
  const pinned = state.tabs.filter((t) => t.pinned);
  const activeStillExists = pinned.some((t) => t.id === state.activeTabId);
  return { tabs: pinned, activeTabId: activeStillExists ? state.activeTabId : HOME_TAB_ID };
}

export function activateTab(state: TabState, tabId: string): TabState {
  if (!state.tabs.some((t) => t.id === tabId)) return state;
  return { ...state, activeTabId: tabId };
}

export function reorderTabs(state: TabState, fromIndex: number, toIndex: number): TabState {
  if (fromIndex === toIndex) return state;
  // Don't allow moving the home tab or moving anything before it
  if (state.tabs[fromIndex]?.id === HOME_TAB_ID) return state;
  const effectiveTo = Math.max(1, toIndex); // keep index 0 reserved for home
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(fromIndex, 1);
  tabs.splice(effectiveTo, 0, moved);
  return { ...state, tabs };
}

export function togglePinTab(state: TabState, tabId: string): TabState {
  return {
    ...state,
    tabs: state.tabs.map((t) =>
      t.id === tabId ? { ...t, pinned: !t.pinned } : t,
    ),
  };
}

export function updateTabTitle(state: TabState, tabId: string, title: string): TabState {
  return {
    ...state,
    tabs: state.tabs.map((t) =>
      t.id === tabId ? { ...t, title } : t,
    ),
  };
}

export function inferTabType(path: string): TabType {
  if (path.includes(".dench.app")) return "app";
  if (path.startsWith("~cron")) return "cron";
  return "file";
}

export function inferTabTitle(path: string, name?: string): string {
  if (name) return name;
  return path.split("/").pop() || path;
}
