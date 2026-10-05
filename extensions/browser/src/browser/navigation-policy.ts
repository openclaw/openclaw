import { resolveBrowserNavigationProxyMode } from "./browser-proxy-mode.js";
import { isLocalManagedProfile, type ResolvedBrowserProfile } from "./config.js";
import { withBrowserNavigationPolicy } from "./navigation-guard.js";
import { getBrowserRequestScope } from "./request-scope.js";
import { getProfileLifecycle, isProfileGenerationCurrent } from "./server-context.lifecycle.js";
import type { BrowserServerState } from "./server-context.types.js";

/** Resolve page policy without widening the stored config or CDP endpoint policy. */
export function resolveBrowserNavigationPolicy(
  state: BrowserServerState,
  profile: ResolvedBrowserProfile,
) {
  const { resolved } = state;
  const policy = withBrowserNavigationPolicy(resolved.ssrfPolicy, {
    browserProxyMode: resolveBrowserNavigationProxyMode({ resolved, profile }),
  });
  const scope = getBrowserRequestScope();
  const assertInvocationCurrent = scope?.assertInvocationCurrent;
  if (
    scope?.allowLocalLoopback !== true ||
    !assertInvocationCurrent ||
    resolved.ssrfPolicyConfigured !== false ||
    !isLocalManagedProfile(profile)
  ) {
    return policy;
  }
  const runtime = state.profiles.get(profile.name);
  const running = runtime?.running;
  if (!runtime || !running) {
    return policy;
  }
  const actor = getProfileLifecycle(runtime);
  const { generation, configRevision } = actor;
  // Availability adopts this handle only after CDP's browser PID matches the launched process.
  const ownsLocalProcess = () =>
    state.profiles.get(profile.name) === runtime &&
    runtime.running === running &&
    runtime.profile.cdpUrl === profile.cdpUrl &&
    running.cdpPort === profile.cdpPort &&
    actor.handles.has(running) &&
    !actor.controller.signal.aborted &&
    running.proc.exitCode == null &&
    running.proc.signalCode == null &&
    isProfileGenerationCurrent({ state, runtime, generation, configRevision });
  if (!ownsLocalProcess()) {
    return policy;
  }
  return {
    ...policy,
    ssrfPolicy: { ...resolved.ssrfPolicy, allowedHostnames: ["localhost", "127.0.0.1", "::1"] },
    assertNavigationCurrent: () => {
      assertInvocationCurrent();
      if (!ownsLocalProcess()) {
        throw new Error(
          "Automatic loopback preview requires the current OpenClaw-owned local browser process",
        );
      }
    },
  };
}
