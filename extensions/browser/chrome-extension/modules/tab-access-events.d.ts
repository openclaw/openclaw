import type { TabAccessEpoch, TabAccessPolicy } from "./tab-access.js";
import type { BrowserTabSnapshot } from "./tab-eligibility.js";

type ChromeEvent<Listener> = {
  addListener(listener: Listener): void;
};

export type TabAccessEventsChromeApi = {
  debugger: {
    onEvent: ChromeEvent<
      (source: { tabId?: number; sessionId?: string }, method: string, params: unknown) => void
    >;
    onDetach: ChromeEvent<(source: { tabId?: number }, reason: string) => void>;
  };
  tabs: {
    onRemoved: ChromeEvent<(tabId: number) => void>;
    onReplaced: ChromeEvent<(addedTabId: number, removedTabId: number) => void>;
    onUpdated: ChromeEvent<
      (
        tabId: number,
        changeInfo: { groupId?: number; url?: string; status?: string },
        tab: BrowserTabSnapshot,
      ) => void
    >;
  };
  tabGroups: {
    onUpdated: ChromeEvent<(group?: { id: number; title?: string }) => void>;
    onRemoved: ChromeEvent<(group?: { id: number; title?: string }) => void>;
  };
};

export type TabAccessEventPolicy = Pick<
  TabAccessPolicy,
  | "mode"
  | "beginRevocation"
  | "endRevocation"
  | "capture"
  | "epochIsCurrent"
  | "invalidateTab"
  | "retireTab"
  | "forwardDocumentEvent"
  | "renewTabAccess"
  | "invalidateGroup"
  | "observeTabUpdate"
  | "forgetTab"
  | "replaceTab"
> & {
  inspectTab(tabId: number, epoch: TabAccessEpoch): Promise<{ accessible: boolean }>;
  listAccessibleTabs(): Promise<Array<{ id: number }>>;
};

export function registerTabAccessEvents(options: {
  chromeApi?: TabAccessEventsChromeApi;
  accessReady: Promise<unknown>;
  policy: TabAccessEventPolicy;
  attachments: Map<
    number,
    { epoch?: TabAccessEpoch; pending?: Promise<unknown>; retired?: boolean }
  >;
  nativeDetached(tabId: number): void;
  send(message: Record<string, unknown>): void;
  scheduleTabsSync(): void;
  detachDebugger(tabId: number): Promise<void>;
  pauseTab(tabId: number): void | Promise<void>;
  removeTabFromOpenClawGroup(tabId: number): void | Promise<void>;
  runAccessMutation(task: () => void | Promise<void>): Promise<void>;
}): void;
