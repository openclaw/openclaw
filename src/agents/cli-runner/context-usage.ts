/** Keep only the latest CLI observation while a store write or its cooldown is pending. */
export function createCliContextPublisher(publish: (tokens: number) => Promise<void>) {
  let latest: number | undefined;
  let written: number | undefined;
  let nextAt = 0;
  let inFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  function schedule() {
    if (closed || inFlight || timer || latest === undefined || latest === written) return;
    const remaining = nextAt - Date.now();
    if (remaining > 0) {
      timer = setTimeout(() => {
        timer = undefined;
        schedule();
      }, remaining);
      timer.unref();
      return;
    }
    written = latest;
    nextAt = Date.now() + 1000;
    inFlight = publish(latest).finally(() => {
      inFlight = undefined;
      schedule();
    });
  }
  return {
    observe(tokens: number) {
      latest = tokens;
      schedule();
    },
    async [Symbol.asyncDispose]() {
      closed = true;
      clearTimeout(timer);
      await inFlight;
    },
  };
}
