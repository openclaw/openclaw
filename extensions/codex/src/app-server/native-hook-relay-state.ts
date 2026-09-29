type PendingUnregister = {
  timeout: ReturnType<typeof setTimeout>;
  unregister: () => void;
};

const pending = new Set<PendingUnregister>();
const closing = new Set<Promise<void>>();

/** Owns delayed hook-relay cleanup across runtime scheduling and test teardown. */
export const nativeHookRelayUnregisterQueue = {
  schedule(relay: { unregister(): void; drain(): Promise<void> }, delayMs: number): void {
    const unregister = () => {
      if (!pending.delete(entry)) {
        return;
      }
      relay.unregister();
      nativeHookRelayUnregisterQueue.track(relay.drain());
    };
    const entry = { timeout: setTimeout(unregister, delayMs), unregister };
    pending.add(entry);
    entry.timeout.unref();
  },
  track(operation: Promise<void>): void {
    closing.add(operation);
    void operation.then(
      () => closing.delete(operation),
      () => closing.delete(operation),
    );
  },
  async flush(): Promise<void> {
    while (pending.size > 0) {
      const entry = pending.values().next().value;
      if (!entry) {
        break;
      }
      clearTimeout(entry.timeout);
      entry.unregister();
    }
    while (closing.size > 0) {
      await Promise.allSettled(closing);
    }
  },
  async clear(): Promise<void> {
    for (const entry of pending) {
      clearTimeout(entry.timeout);
    }
    pending.clear();
    while (closing.size > 0) {
      await Promise.allSettled(closing);
    }
  },
};
