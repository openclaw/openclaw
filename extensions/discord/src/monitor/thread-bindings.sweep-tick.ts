// Discord sweep tick guard. Mirrors the per-feature in-flight boolean
// pattern from Alix-007's #106395 device-pair notifier, #106396
// voice-call reaper, #106397 logbook background refresh, and #106398
// discord listener queue. Lives in its own file so `thread-bindings.manager.ts`
// does not grow past the legacy size cap enforced by `scripts/check-ts-max-loc.ts`.
export function createGuardedSweepInterval(params: {
  tick: () => Promise<void>;
  intervalMs: number;
  unref?: boolean;
}): { handle: NodeJS.Timeout; stop: () => void } {
  let inFlight = false;
  const guardedTick = async () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      await params.tick();
    } finally {
      inFlight = false;
    }
  };
  const handle = setInterval(() => {
    void guardedTick();
  }, params.intervalMs);
  if (params.unref) {
    handle.unref?.();
  }
  return {
    handle,
    stop: () => {
      clearInterval(handle);
    },
  };
}
