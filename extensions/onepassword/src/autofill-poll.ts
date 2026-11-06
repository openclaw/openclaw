import { setTimeout as sleep } from "node:timers/promises";
import type { AccessRequestStatus, ExtResult } from "./autofill-contract.js";
import { AutofillError } from "./autofill-relay.js";

export type AutofillClock = {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};
export const autofillClock: AutofillClock = {
  now: Date.now,
  async sleep(ms, signal) {
    await sleep(ms, undefined, { signal });
  },
};

/** Schedule from explicit link-open acknowledgement, not creation or delivery. Stop at 2 min. */
function nextAutofillPollDelay(elapsedMs: number): number | null {
  if (elapsedMs < 5_000) {
    return 5_000 - elapsedMs;
  }
  if (elapsedMs < 30_000) {
    return 2_000;
  }
  if (elapsedMs < 60_000) {
    return 5_000;
  }
  // Include the window boundary instead of abandoning the remaining partial interval.
  return elapsedMs < 120_000 ? Math.min(10_000, 120_000 - elapsedMs) : null;
}

/** One invocation-bound checker; callers coalesce by connection + request before entering. */
export async function pollAutofillDecision(params: {
  check(): Promise<ExtResult<AccessRequestStatus>>;
  clock: AutofillClock;
  openedAt: number;
  signal?: AbortSignal;
}): Promise<AccessRequestStatus | null> {
  for (;;) {
    params.signal?.throwIfAborted();
    const elapsed = params.clock.now() - params.openedAt;
    const delay = nextAutofillPollDelay(elapsed);
    if (delay === null || elapsed + delay > 120_000) {
      return null;
    }
    await params.clock.sleep(delay, params.signal);
    const response = await params.check();
    if (response.success) {
      // Unknown future states are final too; never probe them again.
      if (response.result.state !== "pending") {
        return response.result;
      }
    } else if (response.error.code === "extensionNotReady") {
      throw new AutofillError("extensionNotReady");
    } else if (response.error.code === "rateLimitExceeded") {
      await params.clock.sleep(60_000, params.signal);
    } else if (response.error.code !== "timeout" && response.error.code !== "networkError") {
      throw new AutofillError("statusCheckFailed");
    }
  }
}
