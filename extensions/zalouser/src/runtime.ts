import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { ZaloSessionState } from "./session-runtime.js";

const { setRuntime: setZalouserRuntime, getRuntime: getZalouserRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "zalouser",
    errorMessage: "Zalouser runtime not initialized",
  });
export { getZalouserRuntime, setZalouserRuntime };

// Bundled modules survive replacement; the SDK slot follows the invoking instance,
// while direct standalone calls keep their existing process-local session lifetime.
export const zalouserSessionStore = createPluginRuntimeStore<ZaloSessionState>({
  key: "zalouser:sessions",
  errorMessage: "Zalouser sessions not initialized",
});

export function registerZalouserRuntimeLifecycle(api: OpenClawPluginApi): void {
  api.lifecycle.onDispose?.(() => {
    zalouserSessionStore.tryGetRuntime()?.dispose();
    zalouserSessionStore.clearRuntime();
  });
}
