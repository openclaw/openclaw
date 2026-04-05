import {
  startLazyPluginServiceModule,
  type LazyPluginServiceHandle,
  type MullusiPluginService,
} from "mullusi/plugin-sdk/browser-support";

type BrowserControlHandle = LazyPluginServiceHandle | null;

export function createBrowserPluginService(): MullusiPluginService {
  let handle: BrowserControlHandle = null;

  return {
    id: "browser-control",
    start: async () => {
      if (handle) {
        return;
      }
      handle = await startLazyPluginServiceModule({
        skipEnvVar: "MULLUSI_SKIP_BROWSER_CONTROL_SERVER",
        overrideEnvVar: "MULLUSI_BROWSER_CONTROL_MODULE",
        // Keep the default module import static so compiled builds still bundle it.
        loadDefaultModule: async () => await import("./server.js"),
        startExportNames: [
          "startBrowserControlServiceFromConfig",
          "startBrowserControlServerFromConfig",
        ],
        stopExportNames: ["stopBrowserControlService", "stopBrowserControlServer"],
      });
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
