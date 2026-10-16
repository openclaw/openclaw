import type {
  ObservationRoot,
  WatchInvalidation,
  WatchHealth,
  WatchOptions,
  WatchSubscription,
} from "openclaw/plugin-sdk/file-access-runtime";
import { vi } from "vitest";

/** Controlled library boundary; no directory discovery or event transport emulation. */
export function createMemoryObservationHarness() {
  const observations: Array<{
    root: ObservationRoot;
    options: WatchOptions;
    subscription: WatchSubscription;
    close: ReturnType<typeof vi.fn<() => Promise<void>>>;
    dirty: (changes?: WatchInvalidation["changes"], reason?: WatchInvalidation["reason"]) => void;
    health: (facts: Partial<WatchHealth>) => void;
  }> = [];
  const harness = {
    observations,
    closeBarrier: undefined as Promise<void> | undefined,
    created: undefined as (() => void) | undefined,
    watch: vi.fn((authority: ObservationRoot, options: WatchOptions): WatchSubscription => {
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
        ready: Promise.resolve(),
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
        dirty: (changes, reason = "event") => {
          if (health.state !== "closed") {
            options.onInvalidate({ reason, changes });
          }
        },
        health: (facts) => {
          if (health.state === "closed") {
            return;
          }
          health = { ...health, ...facts };
          options.onHealth?.(health);
        },
      });
      harness.created?.();
      return subscription;
    }),
    reset() {
      observations.length = 0;
      harness.closeBarrier = undefined;
      harness.created = undefined;
      harness.watch.mockClear();
    },
  };
  return harness;
}
