import { assertCdpTargetResponsive } from "../cdp.js";
import { BrowserTargetCrashedError, markBrowserTargetCrashed } from "../target-crash.js";

type SnapshotTab = {
  targetId: string;
  wsUrl?: string;
  wsLookup?: Parameters<typeof assertCdpTargetResponsive>[0]["lookup"];
};

/** Reject a dead tab before snapshot work waits out the action budget. */
export async function assertSnapshotTabResponsive(opts: {
  profileCtx: { profile: { cdpUrl: string } };
  tab: SnapshotTab;
  signal?: AbortSignal;
}): Promise<void> {
  if (!opts.tab.wsUrl) {
    return;
  }
  try {
    await assertCdpTargetResponsive({
      wsUrl: opts.tab.wsUrl,
      ...(opts.tab.wsLookup ? { lookup: opts.tab.wsLookup } : {}),
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof BrowserTargetCrashedError) {
      markBrowserTargetCrashed(opts.profileCtx.profile.cdpUrl, opts.tab.targetId);
    }
    throw err;
  }
}
