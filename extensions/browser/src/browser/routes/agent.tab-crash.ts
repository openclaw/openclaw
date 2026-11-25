import { assertCdpTargetResponsive } from "../cdp.js";
import {
  BrowserTargetCrashedError,
  clearBrowserTargetCrashed,
  markBrowserTargetCrashed,
} from "../target-crash.js";

type SnapshotTab = {
  targetId: string;
  wsUrl?: string;
  wsLookup?: Parameters<typeof assertCdpTargetResponsive>[0]["lookup"];
};

/** Reject a dead tab before a route action waits out the action budget. */
export async function assertRouteTabResponsive(opts: {
  profileCtx: { profile: { cdpUrl: string } };
  tab: SnapshotTab;
  signal?: AbortSignal;
}): Promise<void> {
  if (!opts.tab.wsUrl) {
    return;
  }
  try {
    const responsive = await assertCdpTargetResponsive({
      wsUrl: opts.tab.wsUrl,
      ...(opts.tab.wsLookup ? { lookup: opts.tab.wsLookup } : {}),
      signal: opts.signal,
    });
    // An inconclusive probe says nothing about the renderer, so keep its crash observation.
    if (responsive) {
      clearBrowserTargetCrashed(opts.profileCtx.profile.cdpUrl, opts.tab.targetId);
    }
  } catch (err) {
    if (err instanceof BrowserTargetCrashedError) {
      markBrowserTargetCrashed(opts.profileCtx.profile.cdpUrl, opts.tab.targetId);
    }
    throw err;
  }
}
