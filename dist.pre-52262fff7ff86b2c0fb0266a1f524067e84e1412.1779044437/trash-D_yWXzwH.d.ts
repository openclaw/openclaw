//#region extensions/browser/src/browser/session-tab-registry.d.ts
declare function trackSessionBrowserTab(params: {
  sessionKey?: string;
  targetId?: string;
  baseUrl?: string;
  profile?: string;
}): void;
declare function untrackSessionBrowserTab(params: {
  sessionKey?: string;
  targetId?: string;
  baseUrl?: string;
  profile?: string;
}): void;
declare function closeTrackedBrowserTabsForSessions(params: {
  sessionKeys: Array<string | undefined>;
  closeTab?: (tab: {
    targetId: string;
    baseUrl?: string;
    profile?: string;
  }) => Promise<void>;
  onWarn?: (message: string) => void;
}): Promise<number>;
//#endregion
//#region extensions/browser/src/browser/trash.d.ts
declare function movePathToTrash(targetPath: string): Promise<string>;
//#endregion
export { untrackSessionBrowserTab as i, closeTrackedBrowserTabsForSessions as n, trackSessionBrowserTab as r, movePathToTrash as t };