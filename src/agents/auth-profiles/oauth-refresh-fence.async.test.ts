import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createOAuthRefreshCredential } from "./credential-fixtures.test-support.js";
import * as fence from "./oauth-refresh-fence.js";
import { isPendingOAuthRefreshFence } from "./oauth-refresh-marker.js";
import * as sqlite from "./sqlite.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function trackSettlement(promise: Promise<unknown>) {
  const tracked = { settled: false };
  function finish<T>(result: T) {
    tracked.settled = true;
    return result;
  }
  return Object.assign(tracked, {
    outcome: promise.then(
      (value) => finish({ value }),
      (error: unknown) => finish({ error }),
    ),
  });
}

const expectTimeout = (outcome: unknown) =>
  expect(outcome).toEqual({
    error: expect.objectContaining({
      message: expect.stringContaining("exceeded hard timeout (100ms)"),
    }),
  });

it.each([
  ["Error", new Error("synthetic backend failure")],
  ["primitive", "synthetic backend failure"],
  ["undefined", undefined],
] as const)("preserves the original pre-deadline %s rejection", async (_label, rejection) => {
  const settlement = createDeferredCore<never>();
  const rejected = expect(
    fence.observeOAuthRefreshSettlement("rejection", 1_000, settlement.promise),
  ).rejects.toBe(rejection);
  settlement.reject(rejection);
  await rejected;
});

it.each(["success", "failure"] as const)(
  "waits for durable claim and %s settlement before publishing",
  async (outcome) => {
    const root = tempDirs.make("oauth-awaited-sqlite-");
    const agentDir = path.join(root, "agents", "work", "agent");
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const profileId = "synthetic:default";
      const expired = createOAuthRefreshCredential({
        provider: "synthetic",
        expires: 1,
        accountId: "synthetic-account",
      });
      const refreshed: OAuthCredential = {
        ...expired,
        access: "synthetic-refreshed-access",
        refresh: "synthetic-refreshed-refresh",
        expires: Date.now() + 60_000,
      };
      const claim = { entered: createDeferredCore(), release: createDeferredCore() };
      const settlement = { entered: createDeferredCore(), release: createDeferredCore() };
      const providerError = new Error("synthetic provider rejection");
      let operations = 0;
      const read = (database?: sqlite.AuthProfileDatabase) =>
        (sqlite.readPersistedAuthProfileStoreRaw(agentDir, database) as AuthProfileStore).profiles;
      const write = (profiles: AuthProfileStore["profiles"], db?: sqlite.AuthProfileDatabase) =>
        sqlite.writePersistedAuthProfileStoreRaw({ version: 1, profiles }, agentDir, db);
      const commit = vi.fn();
      const refresh = vi.fn(async () => {
        const credential = read()[profileId];
        expect(
          isPendingOAuthRefreshFence(credential?.type === "oauth" ? credential : undefined),
        ).toBe(true);
        if (outcome === "failure") {
          throw providerError;
        }
        return { apiKey: refreshed.access, credential: refreshed };
      });
      write({ [profileId]: expired });
      const tracked = trackSettlement(
        fence.refreshSerializedOAuthCredential({
          backend: {
            async withLock(fn) {
              operations += 1;
              const gate = operations === 2 ? claim : operations === 3 ? settlement : undefined;
              if (gate) {
                gate.entered.resolve();
                await gate.release.promise;
              }
              return sqlite.runAuthProfileWriteTransaction(agentDir, (database) => {
                const update = fn(JSON.stringify(read(database)));
                if (update.next !== undefined) {
                  write(JSON.parse(update.next), database);
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
        }),
      );
      try {
        await Promise.race([claim.entered.promise, tracked.outcome]);
        expect(tracked.settled).toBe(false);
        expect(refresh).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
        claim.release.resolve();
        await Promise.race([settlement.entered.promise, tracked.outcome]);
        expect(tracked.settled).toBe(false);
        expect(refresh).toHaveBeenCalledOnce();
        expect(commit).toHaveBeenCalledTimes(1);
        settlement.release.resolve();
        expect(await tracked.outcome).toEqual(
          outcome === "success"
            ? { value: { apiKey: refreshed.access, credential: refreshed } }
            : { error: providerError },
        );
        expect(commit).toHaveBeenCalledTimes(2);
        sqlite.closeAuthProfileReadPool();
        closeOpenClawAgentDatabasesForTest();
        const persisted = read()[profileId];
        expect(persisted).toMatchObject({
          type: "oauth",
          access:
            outcome === "success" ? refreshed.access : expect.stringContaining(":failed:access:"),
        });
        expect(
          isPendingOAuthRefreshFence(persisted?.type === "oauth" ? persisted : undefined),
        ).toBe(false);
      } finally {
        claim.release.resolve();
        settlement.release.resolve();
        await tracked.outcome;
        sqlite.closeAuthProfileReadPool();
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
      }
    });
  },
);

describe("refresh observers", () => {
  let reading = createDeferredCore<string>();
  let controller = new AbortController();
  const resolve = vi.fn(async (value: string) => value);
  const pending: Promise<unknown>[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    reading = createDeferredCore<string>();
    controller = new AbortController();
    resolve.mockClear();
    pending.length = 0;
  });
  afterEach(async () => {
    controller.abort();
    reading.resolve("cleanup");
    await Promise.allSettled(pending);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  function retain<T>(promise: Promise<T>) {
    pending.push(promise);
    return promise;
  }
  function observe(read: () => string | Promise<string> = () => reading.promise, timeoutMs = 100) {
    return retain(
      fence.observeOAuthRefreshFenceSettlement({
        label: "observer",
        timeoutMs,
        signal: controller.signal,
        read,
        isPending: (value) => value === "pending",
        resolve,
      }),
    );
  }
  const owner = () =>
    retain(fence.observeOAuthRefreshSettlement("owner", 100, reading.promise, controller.signal));
  it.each(["stalled read", "expired snapshot", "expired rejection"])(
    "bounds an observer waiting for a %s",
    async (scenario) => {
      const startedAt = performance.now();
      const clock = vi.spyOn(performance, "now");
      const rejected = expect(observe()).rejects.toThrow("exceeded hard timeout (100ms)");
      if (scenario === "stalled read") {
        await vi.advanceTimersByTimeAsync(100);
      } else {
        await vi.advanceTimersByTimeAsync(0);
        clock.mockReturnValue(startedAt + 101);
        if (scenario === "expired rejection") {
          reading.reject(new Error("synthetic late read failure"));
        } else {
          reading.resolve("settled");
        }
      }
      await rejected;
      reading.resolve("settled");
      await reading.promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it.each(["reading", "polling"] as const)(
    "cancels a pending observer while %s without leaving polling work",
    async (phase) => {
      const entered = createDeferredCore();
      const read = vi.fn(() => {
        entered.resolve();
        return phase === "reading" ? reading.promise : "pending";
      });
      const rejected = expect(observe(read, 1_000)).rejects.toMatchObject({ name: "AbortError" });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(new DOMException("caller cancelled", "AbortError"));
      await rejected;
      reading.resolve("settled");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(read).toHaveBeenCalledOnce();
      expect(resolve).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each([
    ["owner", -60_000],
    ["owner", 60_000],
    ["blocked read", -60_000],
    ["blocked read", 60_000],
    ["polling", -60_000],
    ["polling", 60_000],
    ["owner", null],
    ["fence", null],
    ["polling", null],
  ] as const)(
    "preserves the %s deadline with wall step %s (null = fractional clock)",
    async (kind, wallStep) => {
      const fakeNow = performance.now.bind(performance);
      if (wallStep === null) {
        // Advance the high-resolution clock between deadline creation and timer arming.
        vi.spyOn(performance, "now")
          .mockImplementationOnce(() => fakeNow() + 0.25)
          .mockImplementation(() => fakeNow() + 0.75);
      } else {
        vi.setSystemTime(100_000);
      }
      let lastReadAt: number | undefined;
      const read = () => {
        if (kind !== "polling") {
          return reading.promise;
        }
        if (wallStep === null) {
          const now = fakeNow();
          // Fail a zero-delay polling regression instead of spinning forever.
          if (lastReadAt === now) {
            throw new Error("polling did not advance the clock");
          }
          lastReadAt = now;
        }
        return "pending";
      };
      const tracked = trackSettlement(kind === "owner" ? owner() : observe(read));
      if (wallStep !== null) {
        await vi.advanceTimersByTimeAsync(0);
        vi.setSystemTime(Date.now() + wallStep);
      }
      await vi.advanceTimersByTimeAsync(99);
      expect(tracked.settled).toBe(false);
      if (wallStep === null && kind !== "polling") {
        reading.resolve("settled before deadline");
        expect(await tracked.outcome).toEqual({ value: "settled before deadline" });
      } else {
        await vi.advanceTimersByTimeAsync(1);
        expect(tracked.settled).toBe(true);
        expectTimeout(await tracked.outcome);
      }
      if (wallStep !== null) {
        reading.resolve("settled");
        await vi.advanceTimersByTimeAsync(100);
        expect(resolve).not.toHaveBeenCalled();
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
