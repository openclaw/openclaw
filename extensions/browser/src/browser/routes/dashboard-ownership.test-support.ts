import type { BrowserTab } from "../client.types.js";
import type { ResolvedBrowserProfile } from "../config.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import { makeBrowserProfile, makeBrowserServerState } from "../server-context.test-harness.js";

export function createDashboardRouteContext(
  tab: BrowserTab,
  options: {
    evaluateEnabled?: boolean;
    selection?: (profile: ResolvedBrowserProfile) => Pick<ProfileContext, "listTabs" | "focusTab">;
  } = {},
): BrowserRouteContext {
  const profile = makeBrowserProfile();
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected browser profile operation");
  };
  const profileCtx: ProfileContext = {
    profile,
    ensureBrowserAvailable: async () => {},
    ensureTabAvailable: async () => tab,
    isHttpReachable: async () => true,
    isTransportAvailable: async () => true,
    isReachable: async () => true,
    listTabs: async () => [tab],
    openTab: unused,
    labelTab: unused,
    focusTab: unused,
    closeTab: unused,
    stopRunningBrowser: unused,
    resetProfile: unused,
    ...options.selection?.(profile),
  };
  const state = makeBrowserServerState({
    profile,
    resolvedOverrides: { evaluateEnabled: options.evaluateEnabled ?? false, ssrfPolicy: undefined },
  });
  return {
    state: () => state,
    forProfile: () => profileCtx,
    listProfiles: unused,
  };
}
