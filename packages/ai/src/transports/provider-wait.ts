import type { StreamOptions } from "../types.js";

/** A provider-owned wait lasts only until its first response event or settlement. */
export function createProviderWaitObserver(
  options: Pick<StreamOptions, "onProviderWait" | "signal"> | undefined,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let stopped = false;
  let shown: "response" | "slot" | undefined;
  const signal = options?.signal;
  const notify = options?.onProviderWait;

  const report = (reason: "response" | "slot") => {
    if (!started || stopped || !notify || shown === reason) {
      return;
    }
    shown = reason;
    notify(reason);
  };
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    if (shown) {
      shown = undefined;
      notify?.(null);
    }
  };

  return {
    start() {
      if (started || stopped || !notify || signal?.aborted) {
        return;
      }
      started = true;
      signal?.addEventListener("abort", stop, { once: true });
      timer = setTimeout(() => {
        if (!shown) {
          report("response");
        }
      }, 1_000);
      timer.unref?.();
    },
    report,
    stop,
  };
}
