import { isDeepStrictEqual } from "node:util";
import { loadBrowserConfigForRuntimeRefresh } from "./config-refresh-source.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import { beginProfileTransition, getProfileLifecycle } from "./server-context.lifecycle.js";
import type { BrowserServerState } from "./server-context.types.js";

export function refreshResolvedBrowserConfigFromDisk(params: {
  current: BrowserServerState;
  refreshConfigFromDisk: boolean;
}) {
  if (!params.refreshConfigFromDisk) {
    return;
  }

  // Route-level refresh should use the shared runtime config. Config mutations
  // refresh that snapshot and decide whether the wider runtime should restart.
  const cfg = loadBrowserConfigForRuntimeRefresh();
  const freshResolved = resolveBrowserConfig(cfg.browser, cfg);
  const { current } = params;
  const previousResolved = current.resolved;
  const extensionRelayInternalTokens: Record<string, string> = {};
  for (const [name, relay] of current.extensionRelays ?? []) {
    const runtime = current.profiles.get(name);
    const lifecycle = runtime && getProfileLifecycle(runtime);
    const profile = resolveProfile(freshResolved, name);
    if (
      runtime?.profile.driver === "extension" &&
      !lifecycle?.terminal &&
      !lifecycle?.transitionReason &&
      !lifecycle?.cleanupRelays.has(relay) &&
      profile?.driver === "extension" &&
      profile.cdpPort === relay.port &&
      relay.ownership !== "borrowed"
    ) {
      extensionRelayInternalTokens[name] = relay.internalToken;
    }
  }
  current.resolved = {
    ...freshResolved,
    // Admission, security and relay authentication belong to the running
    // service; a request must not adopt changes that are waiting for its restart.
    enabled: previousResolved.enabled,
    evaluateEnabled: previousResolved.evaluateEnabled,
    ssrfPolicy: previousResolved.ssrfPolicy,
    ssrfPolicyConfigured: previousResolved.ssrfPolicyConfigured,
    extensionRelay: previousResolved.extensionRelay,
    // Only an exact live relay owns its process-local CDP credential; stale
    // config snapshots must never resurrect closed or replaced credentials.
    extensionRelayInternalTokens,
    // Config refresh must not erase the lifecycle's key while a relay is starting.
    extensionRelayToken: previousResolved.extensionRelayToken,
  };
  for (const [name, runtime] of current.profiles) {
    const actor = getProfileLifecycle(runtime);
    if (actor.terminal) {
      continue;
    }
    const nextProfile = resolveProfile(current.resolved, name);
    if (nextProfile) {
      const before = runtime.profile;
      const changed: string[] = (["cdpUrl", "cdpPort", "driver"] as const).filter(
        (key) => before[key] !== nextProfile[key],
      );
      const currentUsesLocalManagedLaunch =
        before.driver === "openclaw" && !before.attachOnly && before.cdpIsLoopback;
      const nextUsesLocalManagedLaunch =
        nextProfile.driver === "openclaw" && !nextProfile.attachOnly && nextProfile.cdpIsLoopback;
      if ((before.engine ?? "chromium") !== (nextProfile.engine ?? "chromium")) {
        changed.push("engine");
      }
      if (currentUsesLocalManagedLaunch && nextUsesLocalManagedLaunch) {
        changed.push(
          ...(["headless", "executablePath"] as const).filter(
            (key) => before[key] !== nextProfile[key],
          ),
        );
        if (previousResolved.noSandbox !== freshResolved.noSandbox) {
          changed.push("noSandbox");
        }
        if (!isDeepStrictEqual(previousResolved.extraArgs, freshResolved.extraArgs)) {
          changed.push("extraArgs");
        }
      }
      changed.push(
        ...(["attachOnly", "cdpIsLoopback"] as const).filter(
          (key) => before[key] !== nextProfile[key],
        ),
        ...(["userDataDir", "mcpCommand"] as const).filter(
          (key) => (before[key] ?? "") !== (nextProfile[key] ?? ""),
        ),
      );
      if (!isDeepStrictEqual(before.mcpArgs, nextProfile.mcpArgs)) {
        changed.push("mcpArgs");
      }
      if (changed.length > 0) {
        const reason = `profile invariants changed: ${changed.join(", ")}`;
        void beginProfileTransition({
          state: current,
          runtime,
          reason,
          closeRelay: before.driver === "extension",
          exposeReason: true,
        }).catch(() => {});
        runtime.lastTargetId = null;
      }
      runtime.profile = nextProfile;
      continue;
    }
    // Failed cleanup stays visible; an explicit stop or restart repairs it.
    runtime.lastTargetId = null;
    void beginProfileTransition({
      state: current,
      runtime,
      reason: "profile removed from config",
      terminal: "config-removed",
      closeRelay: runtime.profile.driver === "extension",
      exposeReason: true,
    })
      .then(() => {
        if (current.profiles.get(name) === runtime) {
          current.profiles.delete(name);
        }
      })
      .catch(() => {});
  }
}
