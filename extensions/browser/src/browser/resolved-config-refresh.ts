import * as browserConfigRuntime from "../config/config.js";
import { resolveBrowserConfig, resolveProfile, type ResolvedBrowserProfile } from "./config.js";
import type { BrowserServerState } from "./server-context.types.js";

function changedProfileInvariants(
  current: ResolvedBrowserProfile,
  next: ResolvedBrowserProfile,
): string[] {
  const changed: string[] = [];
  if (current.cdpUrl !== next.cdpUrl) {
    changed.push("cdpUrl");
  }
  if (current.cdpPort !== next.cdpPort) {
    changed.push("cdpPort");
  }
  if (current.driver !== next.driver) {
    changed.push("driver");
  }
  if (current.attachOnly !== next.attachOnly) {
    changed.push("attachOnly");
  }
  if (current.cdpIsLoopback !== next.cdpIsLoopback) {
    changed.push("cdpIsLoopback");
  }
  if ((current.userDataDir ?? "") !== (next.userDataDir ?? "")) {
    changed.push("userDataDir");
  }
  return changed;
}

function applyResolvedConfig(
  current: BrowserServerState,
  freshResolved: BrowserServerState["resolved"],
) {
  current.resolved = {
    ...freshResolved,
    // Keep the runtime evaluate gate stable across request-time profile refreshes.
    // Security-sensitive behavior should only change via full runtime config reload,
    // not as a side effect of resolving profiles/tabs during a request.
    evaluateEnabled: current.resolved.evaluateEnabled,
  };
  for (const [name, runtime] of current.profiles) {
    const nextProfile = resolveProfile(freshResolved, name);
    if (nextProfile) {
      const changed = changedProfileInvariants(runtime.profile, nextProfile);
      if (changed.length > 0) {
        runtime.reconcile = {
          previousProfile: runtime.profile,
          reason: `profile invariants changed: ${changed.join(", ")}`,
        };
        runtime.lastTargetId = null;
      }
      runtime.profile = nextProfile;
      continue;
    }
    runtime.reconcile = {
      previousProfile: runtime.profile,
      reason: "profile removed from config",
    };
    runtime.lastTargetId = null;
    if (!runtime.running) {
      current.profiles.delete(name);
    }
  }
}

export function refreshResolvedBrowserConfigFromDisk(params: {
  current: BrowserServerState;
  refreshConfigFromDisk: boolean;
  mode: "cached" | "fresh";
}) {
  if (!params.refreshConfigFromDisk) {
    return;
  }

  const cfg =
    params.mode === "fresh"
      ? // Fresh mode bypasses the shared cached snapshot so request-time profile
        // lookups can observe new on-disk profiles without mutating global cache state.
        browserConfigRuntime.createConfigIO().loadConfig()
      : // Cached mode preserves the normal runtime snapshot semantics and only falls back
        // to the shared config loader when no snapshot has been primed yet.
        (browserConfigRuntime.getRuntimeConfigSnapshot() ?? browserConfigRuntime.loadConfig());
  const freshResolved = resolveBrowserConfig(cfg.browser, cfg);
  applyResolvedConfig(params.current, freshResolved);
}

export function resolveBrowserProfileWithHotReload(params: {
  current: BrowserServerState;
  refreshConfigFromDisk: boolean;
  name: string;
}): ResolvedBrowserProfile | null {
  refreshResolvedBrowserConfigFromDisk({
    current: params.current,
    refreshConfigFromDisk: params.refreshConfigFromDisk,
    mode: "cached",
  });
  let profile = resolveProfile(params.current.resolved, params.name);
  if (profile) {
    return profile;
  }

  // Hot-reload: profile missing; retry with a fresh disk read without flushing the global cache.
  refreshResolvedBrowserConfigFromDisk({
    current: params.current,
    refreshConfigFromDisk: params.refreshConfigFromDisk,
    mode: "fresh",
  });
  profile = resolveProfile(params.current.resolved, params.name);
  return profile;
}
