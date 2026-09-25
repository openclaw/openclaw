import type { Root } from "@openclaw/fs-safe/root";
import type {
  WatchDirty,
  WatchHealth,
  WatchOptions,
  WatchSubscription,
} from "@openclaw/fs-safe/watch";
import { vi } from "vitest";

/** Controlled library boundary; no directory discovery or event transport emulation. */
export function createMemoryObservationHarness() {
  const observations: Array<{
    root: Root;
    options: WatchOptions;
    subscription: WatchSubscription;
    close: ReturnType<typeof vi.fn<() => Promise<void>>>;
    dirty: (changes?: WatchDirty["changes"], reason?: WatchDirty["reason"]) => void;
    health: (facts: Partial<WatchHealth>) => void;
  }> = [];
  const harness = {
    observations,
    ready: undefined as Promise<void> | undefined,
    closeBarrier: undefined as Promise<void> | undefined,
    created: undefined as (() => void) | undefined,
    watch: vi.fn((authority: Root, options: WatchOptions): WatchSubscription => {
      let health: WatchHealth = {
        state: "ready",
        generation: 1,
        mode: options.mode ?? "node",
        directories: 1,
        observedDirectories: 1,
        workers: 1,
        scannedEntries: 0,
        reconciliations: 1,
        pendingInvalidations: 0,
      };
      const closeBarrier = harness.closeBarrier;
      const close = vi.fn(() => {
        health = { ...health, state: "closed", workers: 0, directories: 0 };
        return closeBarrier ?? Promise.resolve();
      });
      const subscription: WatchSubscription = {
        ready: harness.ready ?? Promise.resolve(),
        close,
        [Symbol.asyncDispose]: close,
        health: () => health,
        reconcile: vi.fn(async () => undefined),
        update: vi.fn(async (scopes) => {
          options.scopes = scopes;
        }),
      };
      observations.push({
        root: authority,
        options,
        subscription,
        close,
        // Deliberately deliver even after close: consumers must fence stale callbacks.
        dirty: (changes, reason = "event") =>
          options.onDirty({ generation: 1, scopes: options.scopes, reason, changes }),
        health: (facts) => {
          health = { ...health, ...facts };
          options.onHealth?.(health);
        },
      });
      harness.created?.();
      return subscription;
    }),
    reset() {
      observations.length = 0;
      harness.ready = undefined;
      harness.closeBarrier = undefined;
      harness.created = undefined;
      harness.watch.mockClear();
    },
  };
  return harness;
}
