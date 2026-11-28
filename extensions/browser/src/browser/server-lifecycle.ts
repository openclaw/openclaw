import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import { stopOpenClawChrome } from "./chrome.js";
import type { BrowserServerState } from "./server-context.js";
import { beginProfileTransition } from "./server-context.lifecycle.js";

const PROFILE_SHUTDOWN_GRACE_MS = 5_000;

/** Invalidate every profile before awaiting any cleanup, then drain in parallel. */
export async function stopKnownBrowserProfiles(params: {
  current: BrowserServerState;
  closeSharedAdapters: boolean;
  onWarn: (message: string) => void;
}) {
  const drains = [...params.current.profiles.values()].map(async (runtime) => {
    const drain = beginProfileTransition({
      state: params.current,
      runtime,
      reason: "Browser runtime shutdown",
      closeSharedAdapters: params.closeSharedAdapters,
    });
    if (await raceWithTimeout(drain, PROFILE_SHUTDOWN_GRACE_MS, () => null, { ref: false })) {
      return;
    }
    // A renderer may never answer the operation holding the lease. Close only
    // our exact child to unblock it; never terminate an attached browser.
    if (runtime.running) {
      await stopOpenClawChrome(runtime.running);
      if (await raceWithTimeout(drain, PROFILE_SHUTDOWN_GRACE_MS, () => null, { ref: false })) {
        return;
      }
    }
    throw new Error(`Browser profile "${runtime.profile.name}" shutdown timed out.`);
  });
  const settled = await Promise.allSettled(drains);
  const failed = settled.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") {
    params.onWarn(`openclaw browser stop failed: ${String(failed.reason)}`);
    throw failed.reason;
  }
}
