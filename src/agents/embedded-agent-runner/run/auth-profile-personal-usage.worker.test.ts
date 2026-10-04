import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../../state/openclaw-state-db-async-lifecycle.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import * as workerStore from "../../../state/openclaw-state-worker-store.js";
import {
  connectUserModelAccount,
  readUserModelAuthProfile,
  updateUserModelAuthProfile,
} from "../../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { loadPersistedAuthProfileStore } from "../../auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../auth-profiles/runtime-snapshots.js";
import { ensureAuthProfileStore } from "../../auth-profiles/store-runtime.js";
import type { AuthProfileCredential, AuthProfileFailureReason } from "../../auth-profiles/types.js";
import { markEmbeddedRunAuthProfileSuccess } from "./auth-profile-success.js";
import { createEmbeddedRunFailoverRetryController } from "./failover-retry-controller.js";

const provider = "anthropic";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearRuntimeAuthProfileStoreSnapshots();
  clearRuntimeConfigSnapshot();
});

function fixture(
  state: OpenClawTestState,
  credential: AuthProfileCredential = {
    type: "token",
    provider,
    token: "synthetic-personal-token",
  },
) {
  const config = { agents: { entries: { main: {} } } };
  setRuntimeConfigSnapshot(config, config);
  const owner = ensureProfileForEmail("personal-usage@example.test");
  const { authProfileId: profileId } = connectUserModelAccount({
    ownerProfileId: owner.id,
    credential,
    assertCurrent() {},
  });
  const agentDir = state.agentDir();
  const store = ensureAuthProfileStore(agentDir, { profileId });
  const initial = structuredClone(readUserModelAuthProfile(profileId));
  const database = openOpenClawStateDatabase();
  const controller = createEmbeddedRunFailoverRetryController({
    runParams: {
      runId: "personal-usage-run",
      sessionId: "personal-usage-session",
      sessionFile: state.path("synthetic-session.jsonl"),
      workspaceDir: state.workspaceDir,
      prompt: "synthetic personal-account failure",
      timeoutMs: 60_000,
      config,
    },
    provider: credential.provider,
    modelId: "synthetic-model",
    globalLane: "personal-usage-test",
    agentDir,
    fallbackConfigured: false,
    hasRemainingAuthAttempt: () => false,
    profileFailureStore: store,
    getLastProfileId: () => profileId,
    getSessionId: () => "personal-usage-session",
    harnessOwnsTransport: () => false,
    getRuntimeAuthOwnerId: () => "embedded",
    getApiKeyInfo: () => null,
    advanceAuthProfile: async () => false,
  });
  return {
    profileId,
    store,
    initial,
    agentDir,
    database,
    fail: (reason: AuthProfileFailureReason = "timeout") =>
      controller.maybeMarkAuthProfileFailure({ profileId, reason }),
    succeed: () =>
      markEmbeddedRunAuthProfileSuccess({
        profileId,
        profileStore: store,
        provider: credential.provider,
        agentDir,
        runId: "personal-usage-run",
        sessionId: "personal-usage-session",
      }),
  };
}

function holdAdmittedWorkerOperation() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const original = workerStore.runOpenClawStateWorkerOperation;
  const spy = vi.spyOn(workerStore, "runOpenClawStateWorkerOperation").mockImplementation(
    new Proxy(original, {
      apply(target, receiver, args: Parameters<typeof original>) {
        const [context, operation, options] = args;
        return Reflect.apply(target, receiver, [
          context,
          async (scope: Parameters<typeof operation>[0]) => {
            entered.resolve();
            await release.promise;
            return operation(scope);
          },
          options,
        ]);
      },
    }),
  );
  return { entered: entered.promise, release: release.resolve, restore: () => spy.mockRestore() };
}

it("reduces embedded personal-account success and failover failure without caller-thread SQL", async () => {
  await withOpenClawTestState(
    { label: "personal-usage-worker", scenario: "minimal" },
    async (state) => {
      const { profileId, store, initial, agentDir, database, succeed, fail } = fixture(state);
      const maintenance = createOpenClawDatabaseMaintenanceScope();
      const sql = observeHostDataSql();
      let queries: string[];
      try {
        database.db.prepare("SELECT 1").get();
        expect(sql.queries.length).toBeGreaterThan(0);
        sql.queries.length = 0;
        expect(maintenance.run(succeed)).toBeUndefined();
        const failure = maintenance.run(fail);
        await failure;
        await maintenance.close();
        queries = [...sql.queries];
      } finally {
        sql.restore();
        await maintenance.close();
      }
      const persisted = readUserModelAuthProfile(profileId);
      expect(persisted?.usageStats).toMatchObject({
        lastUsed: expect.any(Number),
        errorCount: 1,
        failureCounts: { timeout: 1 },
        cooldownReason: "timeout",
      });
      expect(persisted?.credential).toEqual(initial?.credential);
      expect(store.usageStats?.[profileId]).toEqual(persisted?.usageStats);
      expect(store.lastGood?.[provider]).toBeUndefined();
      expect(store.order?.[provider]).toBeUndefined();
      const shared = loadPersistedAuthProfileStore(agentDir);
      expect(shared?.profiles[profileId]).toBeUndefined();
      expect(shared?.usageStats?.[profileId]).toBeUndefined();
      expect(queries).toEqual([]);
    },
  );
});

it.each(["unchanged", "block", "credential"] as const)(
  "binds the personal provider probe to its observed generation: %s",
  async (changed) => {
    await withOpenClawTestState(
      { label: "personal-usage-probe", scenario: "minimal" },
      async (state) => {
        const now = Date.now();
        const { profileId, store, fail } = fixture(state, {
          type: "oauth",
          provider: "openai",
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: now + 3_600_000,
        });
        updateUserModelAuthProfile(profileId, (profile) => {
          profile.usageStats = {
            blockedUntil: now + 600_000,
            blockedReason: "subscription_limit",
            blockedSource: "wham",
            lastFailureAt: now,
            failureCounts: { rate_limit: 1 },
          };
          return true;
        });
        // The probe must read its generation from the owner, not this stale caller view.
        store.usageStats = { [profileId]: { lastUsed: 99 } };
        const entered = createDeferredCore();
        const response = createDeferredCore<Response>();
        vi.stubGlobal(
          "fetch",
          vi.fn(() => {
            entered.resolve();
            return response.promise;
          }),
        );
        let sql = observeHostDataSql();
        const failure = fail("no_error_details");
        void failure.catch(() => undefined);
        try {
          await awaitGateBeforeSettlement(entered.promise, failure, "Probe was not requested");
          expect(sql.queries).toEqual([]);
          sql.restore();
          if (changed !== "unchanged") {
            updateUserModelAuthProfile(profileId, (profile) => {
              if (changed === "credential" && profile.credential.type === "oauth") {
                profile.credential.access = "synthetic-replacement-access";
              } else {
                profile.usageStats = {
                  ...profile.usageStats,
                  blockedUntil: now + 900_000,
                  lastFailureAt: now + 1,
                };
              }
              return true;
            });
          }
          const current = readUserModelAuthProfile(profileId);
          sql = observeHostDataSql();
          response.resolve(
            new Response(JSON.stringify({ rate_limit: { limit_reached: false } }), { status: 200 }),
          );
          await failure;
          expect(sql.queries).toEqual([]);
          sql.restore();
          const persisted = readUserModelAuthProfile(profileId);
          if (changed === "unchanged") {
            expect(persisted?.usageStats?.blockedUntil).toBeUndefined();
            expect(persisted?.usageStats?.lastProbeAt).toEqual(expect.any(Number));
            expect(persisted?.credential).toEqual(current?.credential);
            expect(store.usageStats?.[profileId]).toEqual(persisted?.usageStats);
          } else {
            expect(persisted).toEqual(current);
            expect(store.usageStats?.[profileId]).toEqual({ lastUsed: 99 });
          }
        } finally {
          sql.restore();
          response.resolve(new Response(null, { status: 503 }));
          await Promise.allSettled([failure]);
        }
      },
    );
  },
);

it("refuses stale personal credential generations without overwriting current usage", async () => {
  await withOpenClawTestState(
    { label: "personal-usage-generation", scenario: "minimal" },
    async (state) => {
      const { profileId, store, succeed, fail } = fixture(state);
      const callerBefore = structuredClone(store);
      updateUserModelAuthProfile(profileId, (profile) => {
        profile.credential = { type: "token", provider, token: "synthetic-replacement-token" };
        profile.usageStats = { lastUsed: 17, errorCount: 6, failureCounts: { auth: 6 } };
        return true;
      });
      const replacement = readUserModelAuthProfile(profileId);
      const maintenance = createOpenClawDatabaseMaintenanceScope();
      try {
        maintenance.run(succeed);
        await maintenance.run(fail);
        await maintenance.close();
        expect(readUserModelAuthProfile(profileId)).toEqual(replacement);
        expect(store).toEqual(callerBefore);
      } finally {
        await maintenance.close();
      }
    },
  );
});

it("joins accepted nonblocking embedded bookkeeping before maintenance closes", async () => {
  await withOpenClawTestState(
    { label: "personal-usage-close", scenario: "minimal" },
    async (state) => {
      const { profileId, initial, succeed } = fixture(state);
      const maintenance = createOpenClawDatabaseMaintenanceScope();
      const gate = holdAdmittedWorkerOperation();
      expect(maintenance.run(succeed)).toBeUndefined();
      let closed = false;
      const closing = maintenance.close().then(() => {
        closed = true;
      });
      try {
        await awaitGateBeforeSettlement(
          gate.entered,
          closing,
          "Bookkeeping closed before worker admission",
        );
        expect(closed).toBe(false);
        expect(readUserModelAuthProfile(profileId)).toEqual(initial);
        gate.release();
        await closing;
        expect(readUserModelAuthProfile(profileId)?.usageStats?.lastUsed).toEqual(
          expect.any(Number),
        );
        expect(closed).toBe(true);
      } finally {
        gate.release();
        gate.restore();
        await closing;
      }
    },
  );
});

it("preserves the authority error class and refuses a revoked personal-account write", async () => {
  await withOpenClawTestState(
    { label: "personal-usage-authority", scenario: "minimal" },
    async (state) => {
      const { profileId, store, initial, fail } = fixture(state);
      const callerBefore = structuredClone(store);
      const refused = new TypeError("Synthetic personal-account owner revoked");
      let revoked = false;
      const maintenance = createOpenClawDatabaseMaintenanceScope({
        assertOwnerCurrent() {
          if (revoked) {
            throw refused;
          }
        },
      });
      const gate = holdAdmittedWorkerOperation();
      const failure = maintenance.run(fail);
      const rejection = expect(failure).rejects.toBeInstanceOf(TypeError);
      try {
        await awaitGateBeforeSettlement(
          gate.entered,
          failure,
          "Failure settled before worker admission",
        );
        revoked = true;
        gate.release();
        await rejection;
        await expect(failure).rejects.toThrow(refused.message);
        expect(readUserModelAuthProfile(profileId)).toEqual(initial);
        expect(store).toEqual(callerBefore);
      } finally {
        revoked = false;
        gate.release();
        gate.restore();
        await Promise.allSettled([failure, rejection]);
        await maintenance.close();
      }
    },
  );
});
