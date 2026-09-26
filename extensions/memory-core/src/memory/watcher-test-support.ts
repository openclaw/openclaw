import type { Root } from "@openclaw/fs-safe/root";
import type {
  WatchInvalidation,
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
    dirty: (changes?: WatchInvalidation["changes"], reason?: WatchInvalidation["reason"]) => void;
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
        mode: options.mode === "poll" ? "poll" : "events",
        directories: 1,
      };
      const closeBarrier = harness.closeBarrier;
      const close = vi.fn(() => {
        health = { ...health, state: "closed", directories: 0 };
        return closeBarrier ?? Promise.resolve();
      });
      const subscription: WatchSubscription = {
        ready: harness.ready ?? Promise.resolve(),
        close,
        [Symbol.asyncDispose]: close,
        health: () => health,
        reconcile: vi.fn(async () => undefined),
        setScopes: vi.fn(async (scopes) => {
          options.scopes = scopes;
        }),
      };
      observations.push({
        root: authority,
        options,
        subscription,
        close,
        // Deliberately deliver even after close: consumers must fence stale callbacks.
        dirty: (changes, reason = "event") => options.onInvalidate({ reason, changes }),
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
