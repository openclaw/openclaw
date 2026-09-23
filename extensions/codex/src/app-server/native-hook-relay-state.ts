type PendingUnregister = {
  timeout: ReturnType<typeof setTimeout>;
  unregister: () => void;
};

const pending = new Set<PendingUnregister>();
const closing = new Set<Promise<void>>();

/** Owns delayed hook-relay cleanup across runtime scheduling and test teardown. */
export const nativeHookRelayUnregisterQueue = {
  add(entry: PendingUnregister): void {
    pending.add(entry);
  },
  delete(entry: PendingUnregister): boolean {
    return pending.delete(entry);
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
