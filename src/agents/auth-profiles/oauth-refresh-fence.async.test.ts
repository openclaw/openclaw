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
          vi.setSystemTime(Date.now() + 101);
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
});
