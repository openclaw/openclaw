export function createAsyncGate() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    wait: async () => {
      entered.resolve();
      await released.promise;
    },
  };
}

export function trackPromiseFulfillment<T>(promise: Promise<T>) {
  const tracked = {
    settled: false,
    promise: promise.then((result) => {
      tracked.settled = true;
      return result;
    }),
  };
  return tracked;
}
