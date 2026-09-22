import type { OpenClawPluginGatewayEvents } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
// Browser plugin runtime state shared across lazy bundles and duplicate SDK module instances.
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import type { BrowserDashboardDefinition } from "./browser-dashboard.types.js";

export type BrowserDashboardOperation = {
  promise: Promise<unknown>;
  readonly materializationFailure?: {
    error: unknown;
    definition: BrowserDashboardDefinition;
    callerCancelled: boolean;
  };
};

type BrowserStateRuntime = {
  sessionTabs: PluginStateSyncKeyedStore<unknown>;
  gateway?: PluginRuntime["gateway"];
  dashboardOperations: Map<string, BrowserDashboardOperation>;
  dashboardEvents?: OpenClawPluginGatewayEvents;
};

const {
  setRuntime: setBrowserStateRuntime,
  getRuntime: getBrowserStateRuntime,
  tryGetRuntime: getOptionalBrowserStateRuntime,
} = createPluginRuntimeStore<BrowserStateRuntime>({
  pluginId: "browser",
  errorMessage: "Browser state runtime not initialized",
});

export { getBrowserStateRuntime, getOptionalBrowserStateRuntime, setBrowserStateRuntime };
