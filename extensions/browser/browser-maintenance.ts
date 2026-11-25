import { closeTrackedBrowserTabsForSessions as closeTrackedBrowserTabs } from "./src/browser/session-tab-registry.js";

type CloseTrackedBrowserTabsParams = Parameters<typeof closeTrackedBrowserTabs>[0];

export const supportsSessionEntryCurrent = true;

/** Route lifecycle cleanup through the currently running Browser runtime when available. */
export async function closeTrackedBrowserTabsForSessions(
  params: CloseTrackedBrowserTabsParams,
): Promise<number> {
  return await closeTrackedBrowserTabs({
    ...params,
    getResolvedBrowserConfig: async () => {
      const { getBrowserControlState } = await import("./src/browser-control-state.js");
      return getBrowserControlState()?.resolved ?? null;
    },
  });
}

export { movePathToTrash } from "./src/browser/trash.js";
