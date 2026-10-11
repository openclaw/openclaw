import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  observeOAuthRefreshFenceSettlement,
  observeOAuthRefreshSettlement,
  refreshSerializedOAuthCredential,
} from "./oauth-refresh-fence.js";
import { isPendingOAuthRefreshFence } from "./oauth-refresh-marker.js";
import {
  closeAuthProfileReadPool,
  readPersistedAuthProfileStoreRaw,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStoreRaw,
} from "./sqlite.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("awaited OAuth persistence", () => {
  it.each([
    { label: "Error", rejection: new Error("synthetic backend failure") },
    { label: "primitive", rejection: "synthetic backend failure" },
    { label: "undefined", rejection: undefined },
  ])("preserves the original pre-deadline $label rejection", async ({ rejection }) => {
    const settlement = createDeferredCore<never>();
    const observing = observeOAuthRefreshSettlement(
      "synthetic rejection",
      1_000,
      settlement.promise,
    );
    const rejected = expect(observing).rejects.toBe(rejection);
    settlement.reject(rejection);
    await rejected;
  });

  it.each(["stalled read", "expired snapshot", "expired rejection"])(
    "bounds an observer waiting for a %s",
    async (scenario) => {
      vi.useFakeTimers();
      const reading = createDeferredCore<{ pending: boolean }>();
      const resolve = vi.fn(async () => "synthetic-access");
      const observing = observeOAuthRefreshFenceSettlement({
        label: "synthetic observer",
        timeoutMs: 100,
        read: () => reading.promise,
        isPending: (snapshot) => snapshot.pending,
        resolve,
      });
      const rejected = expect(observing).rejects.toThrow("exceeded hard timeout (100ms)");
      try {
        if (scenario === "stalled read") {
          await vi.advanceTimersByTimeAsync(100);
        } else {
          // Advance the monotonic clock past the deadline so the observer times out.
          // The late settlement (resolved/rejected below) must not override the timeout.
          await vi.advanceTimersByTimeAsync(101);
          if (scenario === "expired rejection") {
            reading.reject(new Error("synthetic late read failure"));
          } else {
            reading.resolve({ pending: false });
          }
        }
        await rejected;
        reading.resolve({ pending: false });
        await reading.promise.catch(() => {});
        await vi.advanceTimersByTimeAsync(0);
        expect(resolve).not.toHaveBeenCalled();
      } finally {
        reading.resolve({ pending: false });
        await observing.catch(() => {});
        vi.useRealTimers();
      }
    },
  );

  it.each(["reading", "polling"] as const)(
    "cancels a pending refresh observer while %s without leaving polling work",
    async (phase) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const reading = createDeferredCore<{ pending: boolean }>();
      const entered = createDeferredCore();
      const read = vi.fn(() => {
        entered.resolve();
        return phase === "reading" ? reading.promise : { pending: true };
      });
      const resolve = vi.fn(async () => "access");
      const observing = observeOAuthRefreshFenceSettlement({
        label: "cancelled observer",
        timeoutMs: 1_000,
        signal: controller.signal,
        read,
        isPending: (snapshot) => snapshot.pending,
        resolve,
      });
      const rejected = expect(observing).rejects.toMatchObject({ name: "AbortError" });
      try {
        await entered.promise;
        await vi.advanceTimersByTimeAsync(0);
        controller.abort(new DOMException("caller cancelled", "AbortError"));
        await rejected;
        reading.resolve({ pending: false });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(read).toHaveBeenCalledOnce();
        expect(resolve).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        controller.abort();
        reading.resolve({ pending: false });
        await observing.catch(() => {});
        vi.useRealTimers();
      }
    },
  );

  it.each(["success", "failure"] as const)(
    "waits for durable claim and %s settlement before publishing",
    async (outcome) => {
      const root = tempDirs.make("oauth-awaited-sqlite-");
      const agentDir = path.join(root, "agents", "work", "agent");
      await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
        const profileId = "synthetic:default";
        const expired: OAuthCredential = {
          type: "oauth",
          provider: "synthetic",
          access: "synthetic-expired-access",
          refresh: "synthetic-expired-refresh",
          expires: 1,
          accountId: "synthetic-account",
        };
        const refreshed: OAuthCredential = {
          ...expired,
          access: "synthetic-refreshed-access",
          refresh: "synthetic-refreshed-refresh",
          expires: Date.now() + 60_000,
        };
        const claimEntered = createDeferredCore();
        const claimRelease = createDeferredCore();
        const settlementEntered = createDeferredCore();
        const settlementRelease = createDeferredCore();
        const providerError = new Error("synthetic provider rejection");
        let operations = 0;
        let settled = false;
        const commit = vi.fn();
        const refresh = vi.fn(async () => {
          const current = readPersistedAuthProfileStoreRaw(agentDir) as AuthProfileStore;
          const credential = current.profiles[profileId];
          expect(
            isPendingOAuthRefreshFence(credential?.type === "oauth" ? credential : undefined),
          ).toBe(true);
          if (outcome === "failure") {
            throw providerError;
          }
          return { apiKey: refreshed.access, credential: refreshed };
        });
        writePersistedAuthProfileStoreRaw(
          { version: 1, profiles: { [profileId]: expired } },
          agentDir,
        );
        const running = refreshSerializedOAuthCredential({
          backend: {
            async withLock<T>(
              fn: (current: string | undefined) => { result: T; next?: string },
            ): Promise<T> {
              operations += 1;
              if (operations === 2) {
                claimEntered.resolve();
                await claimRelease.promise;
              } else if (operations === 3) {
                settlementEntered.resolve();
                await settlementRelease.promise;
              }
              return runAuthProfileWriteTransaction(agentDir, (database) => {
                const current = readPersistedAuthProfileStoreRaw(
                  agentDir,
                  database,
                ) as AuthProfileStore;
                const update = fn(JSON.stringify(current.profiles));
                if (update.next !== undefined) {
                  writePersistedAuthProfileStoreRaw(
                    { version: 1, profiles: JSON.parse(update.next) },
                    agentDir,
                    database,
                  );
                }
                return update.result;
              });
            },
          },
          provider: "synthetic",
          profileId,
          label: "synthetic awaited persistence",
          timeoutMs: 5_000,
          parse: (current) => JSON.parse(current ?? "{}") as Record<string, OAuthCredential>,
          serialize: JSON.stringify,
          readCredential: (data) => data[profileId],
          writeCredential: (data, credential) => ({ ...data, [profileId]: credential }),
          canRefresh: async () => true,
          refresh,
          resolve: async (credential) => ({ apiKey: credential.access, credential }),
          commit,
        });
        const observed = running.then(
          (value) => {
            settled = true;
            return { value };
          },
          (error: unknown) => {
            settled = true;
            return { error };
          },
        );
        try {
          await Promise.race([claimEntered.promise, observed]);
          expect(settled).toBe(false);
          expect(refresh).not.toHaveBeenCalled();
          expect(commit).not.toHaveBeenCalled();
          claimRelease.resolve();
          await Promise.race([settlementEntered.promise, observed]);
          expect(settled).toBe(false);
          expect(refresh).toHaveBeenCalledOnce();
          expect(commit).toHaveBeenCalledTimes(1);
          settlementRelease.resolve();
          const result = await observed;
          expect(commit).toHaveBeenCalledTimes(2);
          if (outcome === "success") {
            expect(result).toEqual({ value: { apiKey: refreshed.access, credential: refreshed } });
          } else {
            expect(result).toEqual({ error: providerError });
          }
          closeAuthProfileReadPool();
          closeOpenClawAgentDatabasesForTest();
          const persistedStore = readPersistedAuthProfileStoreRaw(agentDir) as AuthProfileStore;
          const persisted = persistedStore.profiles[profileId];
          expect(persisted).toMatchObject({
            type: "oauth",
            access:
              outcome === "success" ? refreshed.access : expect.stringContaining(":failed:access:"),
          });
          expect(
            isPendingOAuthRefreshFence(persisted?.type === "oauth" ? persisted : undefined),
          ).toBe(false);
        } finally {
          claimRelease.resolve();
          settlementRelease.resolve();
          await observed;
          closeAuthProfileReadPool();
          closeOpenClawAgentDatabasesForTest();
          closeOpenClawStateDatabaseForTest();
        }
      });
    },
  );

  // Behavioral regression: a wall-clock rewind during the polling loop must
  // not inflate the remaining observation budget. The polling loop in
  // observeOAuthRefreshFenceSettlement recomputes `remainingMs = deadline -
  // <clock>` each iteration and keeps sleeping while it is positive. With the
  // pre-fix Date.now() deadline, rewinding the wall clock keeps remainingMs
  // positive far past timeoutMs, so the observer never times out on schedule.
  // With the monotonic deadline, remainingMs tracks real elapsed time and the
  // observer rejects at ~timeoutMs regardless of wall-clock jumps.
  it("times out on schedule when the wall clock rewinds mid-poll", async () => {
    vi.useFakeTimers();
    // Drive Date.now backward to simulate a wall-clock rewind; performance.now
    // stays on the fake monotonic clock advanced by advanceTimersByTimeAsync.
    let wallClock = 10_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => wallClock);
    let pending = true;
    const observing = observeOAuthRefreshFenceSettlement({
      label: "rewind poll observer",
      timeoutMs: 100,
      read: () => Promise.resolve({ pending }),
      isPending: (s) => s.pending,
      resolve: vi.fn(async () => "synthetic-access"),
    });
    try {
      // Let the first poll read { pending: true }, then rewind the wall clock
      // by 5,000 ms while only ~50 ms of monotonic time has elapsed.
      await vi.advanceTimersByTimeAsync(0);
      wallClock -= 5_000;
      // Advance monotonic time past the 100 ms budget. Under the old Date.now()
      // deadline the rewound wall clock keeps remainingMs ~5,050 ms and the
      // loop keeps sleeping; under the monotonic deadline it reaches 0 and the
      // observer rejects on schedule. Attach the rejection handler BEFORE
      // advancing so the rejection is never reported as unhandled.
      const settled = observing.then(
        () => "settled" as const,
        () => "rejected" as const,
      );
      await vi.advanceTimersByTimeAsync(100);
      // Under the pre-fix Date.now() deadline the observer is still pending
      // because the rewound wall clock keeps remainingMs positive; under the
      // monotonic deadline it has rejected on schedule.
      const stillPolling = Symbol("still polling");
      const outcome = await Promise.race([settled, Promise.resolve(stillPolling)]);
      expect(outcome).toBe("rejected");
    } finally {
      // Restore the wall clock past the deadline and advance fake time so any
      // still-pending loop (pre-fix) exits on its next iteration instead of
      // hanging the suite. pending=false lets the loop resolve once the sleep
      // fires; the large advance guarantees the sleep queue drains.
      wallClock = 20_000;
      pending = false;
      await vi.advanceTimersByTimeAsync(1_000);
      await observing.catch(() => {});
      dateSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
