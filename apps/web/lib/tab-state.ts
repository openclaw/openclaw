/**
 * Tab state management for the workspace.
 *
 * Tabs are stored in localStorage keyed per workspace.
 * The URL reflects only the active tab's content (backward compatible).
 */

export type TabType = "home" | "file" | "chat" | "app" | "object" | "cron" | "integrations" | "cloud" | "skills" | "gateway-chat";

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
  preview?: boolean;
  /** Channel identifier for gateway-chat tabs (e.g. "telegram", "discord"). */
  channel?: string;
};

export type TabState = {
  tabs: Tab[];
  activeTabId: string | null;
};

export type TabOpenOptions = {
  preview?: boolean;
};

const STORAGE_PREFIX = "dench:tabs";

function storageKey(workspaceId?: string | null): string {
  return `${STORAGE_PREFIX}:${workspaceId || "default"}`;
}

export function generateTabId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function tabIdentityKey(tab: Tab): string | null {
  if (tab.id === HOME_TAB_ID || tab.type === "home") {
    return null;
  }
  if (tab.path) {
    return `path:${tab.path}`;
  }
  if (tab.sessionKey) {
    return `sessionKey:${tab.sessionKey}`;
  }
  if (tab.type === "chat" && tab.sessionId) {
    return `sessionId:${tab.sessionId}`;
  }
  return null;
}

function mergeDuplicateTabs(primary: Tab, duplicate: Tab): Tab {
  return normalizePreviewFlag({
    ...primary,
    title: primary.title || duplicate.title,
    icon: primary.icon ?? duplicate.icon,
    path: primary.path ?? duplicate.path,
    sessionId: primary.sessionId ?? duplicate.sessionId,
    sessionKey: primary.sessionKey ?? duplicate.sessionKey,
    parentSessionId: primary.parentSessionId ?? duplicate.parentSessionId,
    pinned: primary.pinned || duplicate.pinned,
    preview: primary.preview && duplicate.preview ? true : undefined,
    channel: primary.channel ?? duplicate.channel,
  });
}

function dedupeTabs(state: TabState): TabState {
  let changed = false;
  let activeTabId = state.activeTabId;
  const keyToIndex = new Map<string, number>();
  const tabs: Tab[] = [];

  for (const tab of state.tabs) {
    const key = tabIdentityKey(tab);
    if (!key) {
      tabs.push(tab);
      continue;
    }

    const existingIndex = keyToIndex.get(key);
    if (existingIndex === undefined) {
      keyToIndex.set(key, tabs.length);
      tabs.push(tab);
      continue;
    }

    changed = true;
    if (activeTabId === tab.id) {
      activeTabId = tabs[existingIndex].id;
    }
    tabs[existingIndex] = mergeDuplicateTabs(tabs[existingIndex], tab);
  }

  return changed ? { tabs, activeTabId } : state;
}

function ensureHomeTab(state: TabState): TabState {
  const hasHome = state.tabs.some((t) => t.id === HOME_TAB_ID);
  if (hasHome) {
    // Make sure home is always first
    const home = { ...HOME_TAB, ...state.tabs.find((t) => t.id === HOME_TAB_ID)!, preview: undefined, pinned: true };
    const rest = state.tabs.filter((t) => t.id !== HOME_TAB_ID);
    return { ...state, tabs: [home, ...rest] };
  }
  return {
    tabs: [HOME_TAB, ...state.tabs],
    activeTabId: state.activeTabId || HOME_TAB_ID,
  };
}

function normalizeActiveTab(state: TabState): TabState {
  if (state.tabs.some((tab) => tab.id === state.activeTabId)) {
    return state;
  }
  return {
    ...state,
    activeTabId: state.tabs[state.tabs.length - 1]?.id ?? HOME_TAB_ID,
  };
}

function normalizeTabState(state: TabState): TabState {
  return normalizeActiveTab(ensureHomeTab(dedupeTabs(state)));
}

function normalizePreviewFlag(tab: Tab): Tab {
  if (tab.id === HOME_TAB_ID || tab.type === "home") {
    return HOME_TAB;
  }
  return tab.preview
    ? { ...tab, preview: true, pinned: false }
    : { ...tab, preview: undefined };
}

export function loadTabs(workspaceId?: string | null): TabState {
  if (typeof window === "undefined") return { tabs: [HOME_TAB], activeTabId: HOME_TAB_ID };
  try {
    const raw = localStorage.getItem(storageKey(workspaceId));
    if (!raw) return { tabs: [HOME_TAB], activeTabId: HOME_TAB_ID };
    const parsed = JSON.parse(raw) as TabState;
    if (!Array.isArray(parsed.tabs)) return { tabs: [HOME_TAB], activeTabId: HOME_TAB_ID };
    return normalizeTabState({
      tabs: parsed.tabs.map(normalizePreviewFlag),
      activeTabId: parsed.activeTabId,
    });
  } catch {
    return { tabs: [HOME_TAB], activeTabId: HOME_TAB_ID };
  }
}

export function saveTabs(state: TabState, workspaceId?: string | null): void {
  if (typeof window === "undefined") return;
  try {
    const persisted = normalizeTabState({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
    });
    const serializable: TabState = {
      tabs: persisted.tabs.map(({ id, type, title, icon, path, sessionId, sessionKey, parentSessionId, pinned, preview, channel }) => ({
        id, type, title, icon, path, sessionId, sessionKey, parentSessionId, pinned, preview, channel,
      })),
      activeTabId: persisted.activeTabId,
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
  return tabs.find((t) => t.sessionKey === sessionKey);
}

function findPreviewTabIndex(state: TabState): number {
  const activePreviewIdx = state.tabs.findIndex((tab) => tab.id !== HOME_TAB_ID && tab.preview && tab.id === state.activeTabId);
  if (activePreviewIdx !== -1) {
    return activePreviewIdx;
  }
  return state.tabs.findIndex((tab) => tab.id !== HOME_TAB_ID && tab.preview);
}

export function openTab(state: TabState, tab: Tab, options?: TabOpenOptions): TabState {
  const existing = tab.path
    ? findTabByPath(state.tabs, tab.path)
    : tab.sessionKey
      ? findTabBySessionKey(state.tabs, tab.sessionKey)
      : tab.sessionId
        ? findTabBySessionId(state.tabs, tab.sessionId)
        : undefined;

  if (existing) {
    if (state.activeTabId === existing.id) {
      return state;
    }
    return { ...state, activeTabId: existing.id };
  }

  const nextTab = normalizePreviewFlag({
    ...tab,
    preview: options?.preview ?? true,
  });

  if (!nextTab.preview) {
    return {
      tabs: [...state.tabs, nextTab],
      activeTabId: nextTab.id,
    };
  }

  const previewIdx = findPreviewTabIndex(state);
  if (previewIdx !== -1) {
    const tabs = [...state.tabs];
    tabs[previewIdx] = nextTab;
    return {
      tabs,
      activeTabId: nextTab.id,
    };
  }

  return {
    tabs: [...state.tabs, nextTab],
    activeTabId: nextTab.id,
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
  if (state.activeTabId === tabId) return state;
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
      t.id === tabId
        ? {
            ...t,
            pinned: !t.pinned,
            preview: t.pinned ? t.preview : undefined,
          }
        : t,
    ),
  };
}

export function makeTabPermanent(state: TabState, tabId: string): TabState {
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== tabId || !tab.preview) {
      return tab;
    }
    changed = true;
    return {
      ...tab,
      preview: undefined,
    };
  });
  return changed ? { ...state, tabs } : state;
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
  if (path.startsWith("~cloud")) return "cloud";
  if (path.startsWith("~integrations")) return "integrations";
  if (path.startsWith("~skills")) return "skills";
  return "file";
}

export function inferTabTitle(path: string, name?: string): string {
  if (name) return name;
  return path.split("/").pop() || path;
}
