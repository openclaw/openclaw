import {
  startBrowserControlServerIfEnabled,
  type OpenClawPluginService,
} from "openclaw/plugin-sdk/browser-support";

type BrowserControlHandle = Awaited<ReturnType<typeof startBrowserControlServerIfEnabled>>;

export function createBrowserPluginService(): OpenClawPluginService {
  let handle: BrowserControlHandle = null;

  return {
    id: "browser-control",
    start: async () => {
      if (handle) {
        return;
      }
      handle = await startBrowserControlServerIfEnabled();
    },
    stop: async () => {
      const current = handle;
      handle = null;
      if (!current) {
        return;
      }
      await current.stop().catch(() => {});
    },
  };
}
