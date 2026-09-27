import type { OpenClawPluginGatewayEvents } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
// Browser plugin runtime state shared across lazy bundles and duplicate SDK module instances.
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import type {
  BrowserDashboardDefinition,
  SessionBrowserDashboard,
} from "./browser-dashboard.types.js";

export type BrowserDashboardOperation = {
  promise: Promise<unknown>;
  readonly materializationFailure?: {
    error: unknown;
    definition: BrowserDashboardDefinition;
    callerCancelled: boolean;
  };
};

export type BrowserDashboardRegistration = {
  kind: "dashboard-registration";
  targetId: string;
  profile: string | undefined;
  closeDispatched?: true;
};
export type BrowserSessionTabOperationKey = string | symbol | BrowserDashboardRegistration;

export type BrowserStateRuntime = {
  sessionTabs: PluginStateKeyedStore<unknown>;
  sessionTabInitialization?: Promise<void>;
  sessionTabOperations: Map<BrowserSessionTabOperationKey, Promise<void>>;
  gateway?: PluginRuntime["gateway"];
  dashboardOperations: Map<string, BrowserDashboardOperation>;
  dashboardEvents?: OpenClawPluginGatewayEvents;
  sessionDashboards?: Map<string, SessionBrowserDashboard>;
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

export function isBrowserStateRuntimeCurrent(
  runtime: BrowserStateRuntime | undefined,
  isCurrent?: () => boolean,
): boolean {
  return (!runtime || getOptionalBrowserStateRuntime() === runtime) && isCurrent?.() !== false;
}

export async function readCurrentBrowserState<T>(
  runtime: BrowserStateRuntime | undefined,
  read: () => Promise<T>,
  isCurrent?: () => boolean,
): Promise<T | undefined> {
  if (!isBrowserStateRuntimeCurrent(runtime, isCurrent)) {
    return undefined;
  }
  try {
    const value = await read();
    return isBrowserStateRuntimeCurrent(runtime, isCurrent) ? value : undefined;
  } catch (error) {
    // Revoked preparation is discarded; accepted closes and writes still settle.
    if (!isBrowserStateRuntimeCurrent(runtime, isCurrent)) {
      return undefined;
    }
    throw error;
  }
}

export function getPendingBrowserDashboardRegistrations(
  runtime: BrowserStateRuntime,
  targetId: string | undefined,
  profile: string | undefined,
): Array<{ registration: BrowserDashboardRegistration; settled: Promise<void> }> {
  return [...runtime.sessionTabOperations].flatMap(([key, settled]) =>
    typeof key === "object" &&
    key.kind === "dashboard-registration" &&
    (!targetId || key.targetId === targetId) &&
    (!profile || key.profile === profile)
      ? [{ registration: key, settled }]
      : [],
  );
}
