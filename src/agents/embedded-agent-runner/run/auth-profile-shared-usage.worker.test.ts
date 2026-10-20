import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import * as backoff from "../../../infra/backoff.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { writeConfigMachineState } from "../../../state/config-machine-state-write.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
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
import { resolveAuthProfileOrder } from "../../auth-profiles/order.js";
import { noteCommittedSharedAuthStoreOwnership } from "../../auth-profiles/path-resolve.js";
import {
  buildPersistedAuthProfileSecretsStore,
  loadPersistedAuthProfileStore,
} from "../../auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../auth-profiles/runtime-snapshots.js";
import { writeAuthProfileJsonCell } from "../../auth-profiles/sqlite-json-write.js";
import {
  readAuthProfileJsonCellText,
  SHARED_AUTH_STORE_STATE_KEY,
} from "../../auth-profiles/sqlite-json.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "../../auth-profiles/store-runtime.js";
import { AuthProfileStoreUnreadableError } from "../../auth-profiles/store-unreadable-error.js";
import type {
  AuthProfileCredential,
  AuthProfileFailureReason,
  AuthProfileStore,
} from "../../auth-profiles/types.js";
import { isProfileInCooldown } from "../../auth-profiles/usage-state.js";
import { markEmbeddedRunAuthProfileSuccess } from "./auth-profile-success.js";
import { createEmbeddedRunFailoverRetryController } from "./failover-retry-controller.js";

const provider = "anthropic";
const sharedId = "anthropic:used";
const siblingId = "anthropic:sibling";
const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };
type Owner = "personal" | "shared" | "inherited" | "agent";

function tokenCredential(value: string): AuthProfileCredential {
  return { type: "token", provider, token: value };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearRuntimeAuthProfileStoreSnapshots();
  clearRuntimeConfigSnapshot();
});

async function fixture(
  state: OpenClawTestState,
  owner: Owner,
  credential: AuthProfileCredential = tokenCredential("synthetic-personal-token"),
) {
  const config: OpenClawConfig = {
    agents: { entries: owner === "personal" ? { main: {} } : { main: {}, voice: {} } },
  };
  const agentDir = state.agentDir(owner === "shared" || owner === "personal" ? "main" : "voice");
  let selectedId = sharedId;
  if (owner === "personal") {
    setRuntimeConfigSnapshot(config, config);
    selectedId = connectUserModelAccount({
      ownerProfileId: ensureProfileForEmail("personal-usage@example.test").id,
      credential,
      assertCurrent() {},
    }).authProfileId;
  } else {
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config, config);
    writeConfigMachineState(
      SHARED_AUTH_STORE_STATE_KEY,
      { location: "state-db" },
      { env: state.env },
    );
    noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, state.env);
    const initial: AuthProfileStore = {
      version: 1,
      profiles: {
        [sharedId]: tokenCredential("synthetic-shared-token"),
        [siblingId]: tokenCredential("synthetic-sibling-token"),
      },
      lastGood: { [provider]: siblingId },
      usageStats: {
        [sharedId]: {
          lastUsed: 17,
          errorCount: 2,
          failureCounts: { auth: 2 },
          lastFailureAt: Date.now(),
          disabledUntil: Date.now() + 60_000,
          disabledReason: "auth",
        },
      },
    };
    saveAuthProfileStore(initial, undefined, saveOptions);
    if (owner !== "shared") {
      const local = structuredClone(initial);
      if (owner === "agent") {
        local.profiles[sharedId] = tokenCredential("synthetic-agent-token");
      } else {
        delete local.profiles[sharedId];
        delete local.usageStats;
      }
      saveAuthProfileStore(local, agentDir, saveOptions);
    }
  }
  const store = ensureAuthProfileStore(
    agentDir,
    owner === "personal" ? { profileId: selectedId } : undefined,
  );
  const initial =
    owner === "personal" ? structuredClone(readUserModelAuthProfile(selectedId)) : undefined;
  const sharedBefore = owner === "personal" ? undefined : loadPersistedAuthProfileStore();
  const localBefore = owner === "personal" ? undefined : loadPersistedAuthProfileStore(agentDir);
  const ownerDir = owner === "agent" ? agentDir : undefined;
  const database =
    owner === "agent"
      ? openOpenClawAgentDatabase({ agentId: "voice", env: state.env })
      : openOpenClawStateDatabase();
  const kind: "agent" | "shared-state" = owner === "agent" ? "agent" : "shared-state";
  const credentials =
    owner === "personal" ? undefined : readAuthProfileJsonCellText(database.db, "store", kind);
  const accountProvider = owner === "personal" ? credential.provider : provider;
  const scope = owner === "personal" ? "personal" : "shared";
  const runId = `${scope}-usage-run`;
  const sessionId = `${scope}-usage-session`;
  const controller = createEmbeddedRunFailoverRetryController({
    runInput: {
      runParams: {
        runId,
        sessionId,
        sessionFile: state.path("synthetic-session.jsonl"),
        workspaceDir: state.workspaceDir,
        prompt: `synthetic ${scope}-account failure`,
        timeoutMs: 60_000,
        config,
      },
      globalLane: `${scope}-usage-test`,
      agentDir,
      fallbackConfigured: false,
    },
    preparedRuntime: {
      provider: accountProvider,
      modelId: "synthetic-model",
      profileFailureStore: store,
      snapshot: () => ({
        lastProfileId: selectedId,
        pluginHarnessOwnsTransport: false,
        agentHarness: { id: "embedded" },
      }),
      getApiKeyInfo: () => null,
      advanceAttemptAuthProfile: async () => false,
    },
    getSessionId: () => sessionId,
  });
  return {
    controller,
    profileId: selectedId,
    store,
    initial,
    database,
    kind,
    credentials,
    ownerDir,
    agentDir,
    sharedBefore,
    localBefore,
    fail: (reason: AuthProfileFailureReason = "timeout") =>
      controller.maybeMarkAuthProfileFailure({ profileId: selectedId, reason }),
    succeed: () =>
      markEmbeddedRunAuthProfileSuccess({
        profileId: selectedId,
        profileStore: store,
        provider: accountProvider,
        agentDir: owner === "shared" ? undefined : agentDir,
        runId,
        sessionId,
      }),
  };
}

function withFixture(
  run: (prepared: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
  owner: Owner = "shared",
  credential?: AuthProfileCredential,
) {
  return withOpenClawTestState({ label: "auth-usage", scenario: "minimal" }, async (state) =>
    run(await fixture(state, owner, credential)),
  );
}

it("publishes a same-model Retry-After cooldown before waiting so another run selects a sibling", () =>
  withFixture(async (f) => {
    const maintenance = createOpenClawDatabaseMaintenanceScope();
    maintenance.run(f.succeed);
    await maintenance.close();
    const retryAfterMs = 1_600_000;
    const readDuringWait = vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async () => {
      const concurrentStore = ensureAuthProfileStore(f.agentDir);
      const stats = concurrentStore.usageStats?.[f.profileId];
      expect(stats).toMatchObject({
        errorCount: 1,
        failureCounts: { rate_limit: 1 },
        cooldownReason: "rate_limit",
        cooldownModel: "synthetic-model",
      });
      expect(stats?.cooldownUntil).toBe((stats?.lastFailureAt ?? 0) + retryAfterMs);
      expect(isProfileInCooldown(concurrentStore, f.profileId, Date.now(), "synthetic-model")).toBe(
        true,
      );
      expect(
        resolveAuthProfileOrder({
          store: concurrentStore,
          provider,
          forModel: "synthetic-model",
        })[0],
      ).toBe(siblingId);
    });
    f.controller.observeAttempt({ providerRetryMaxRetries: 1 });
    await expect(
      f.controller.maybeRetryTransient({ reason: "rate_limit", retryAfterMs }),
    ).resolves.toBe(true);
    expect(readDuringWait).toHaveBeenCalledExactlyOnceWith(retryAfterMs, undefined);
    await expect(
      f.controller.maybeRetryTransient({ reason: "rate_limit", retryAfterMs }),
    ).resolves.toBe(false);
    expect(
      loadPersistedAuthProfileStore(f.ownerDir)?.usageStats?.[f.profileId]?.failureCounts,
    ).toEqual({
      rate_limit: 1,
    });
  }));

function interceptWorker(
  intercept: (execute: () => Promise<unknown>) => Promise<unknown>,
  usageOnly = true,
) {
  const original = workerStore.runOpenClawStateWorkerOperation;
  return vi.spyOn(workerStore, "runOpenClawStateWorkerOperation").mockImplementation(
    new Proxy(original, {
      apply(target, receiver, args: Parameters<typeof original>) {
        const [context, operation, options] = args;
        return Reflect.apply(target, receiver, [
          context,
          (scope: Parameters<typeof operation>[0]) =>
            usageOnly
              ? operation({
                  execute: new Proxy(scope.execute, {
                    apply(execute, commandReceiver, commandArgs: Parameters<typeof scope.execute>) {
                      return commandArgs[0].type === "authProfiles.usage"
                        ? intercept(() => Reflect.apply(execute, commandReceiver, commandArgs))
                        : Reflect.apply(execute, commandReceiver, commandArgs);
                    },
                  }),
                })
              : intercept(() => operation(scope)),
          options,
        ]);
      },
    }),
  );
}
function holdWorker(usageOnly = true) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const spy = interceptWorker(async (execute) => {
    entered.resolve();
    await release.promise;
    return execute();
  }, usageOnly);
  return { entered: entered.promise, release: release.resolve, restore: () => spy.mockRestore() };
}

it.each<Owner>(["personal", "shared", "inherited", "agent"])(
  "records embedded success then failure in the %s owner without caller SQL",
  (owner) =>
    withFixture(async (f) => {
      const maintenance = createOpenClawDatabaseMaintenanceScope();
      const sql = observeHostDataSql();
      try {
        f.database.db.prepare("SELECT 1").get();
        expect(sql.queries.length).toBeGreaterThan(0);
        sql.queries.length = 0;
        expect(maintenance.run(f.succeed)).toBeUndefined();
        await maintenance.run(f.fail);
        await maintenance.close();
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
        await maintenance.close();
      }
      const personal = owner === "personal" ? readUserModelAuthProfile(f.profileId) : undefined;
      const persisted =
        owner === "personal" ? undefined : loadPersistedAuthProfileStore(f.ownerDir);
      const usage = personal?.usageStats ?? persisted?.usageStats?.[sharedId];
      expect(usage).toMatchObject({
        lastUsed: owner === "inherited" ? 17 : expect.any(Number),
        errorCount: 1,
        failureCounts: { timeout: 1 },
        cooldownReason: "timeout",
      });
      expect(f.store.usageStats?.[f.profileId]).toEqual(usage);
      if (owner === "personal") {
        expect(personal?.credential).toEqual(f.initial?.credential);
        expect(f.store.lastGood?.[provider]).toBeUndefined();
        expect(f.store.order?.[provider]).toBeUndefined();
        const shared = loadPersistedAuthProfileStore(f.agentDir);
        expect(shared?.profiles[f.profileId]).toBeUndefined();
        expect(shared?.usageStats?.[f.profileId]).toBeUndefined();
      } else {
        expect(usage?.disabledUntil).toBeUndefined();
        expect(persisted?.lastGood?.[provider]).toBe(owner === "inherited" ? siblingId : sharedId);
        expect(readAuthProfileJsonCellText(f.database.db, "store", f.kind)).toBe(f.credentials);
        if (owner === "agent") {
          expect(loadPersistedAuthProfileStore()).toEqual(f.sharedBefore);
        } else if (owner === "inherited") {
          expect(loadPersistedAuthProfileStore(f.agentDir)).toEqual(f.localBefore);
          expect(f.store.lastGood?.[provider]).toBe(siblingId);
        }
      }
    }, owner),
);

it.each(["unchanged", "credential"] as const)(
  "binds the personal provider probe to its credential: %s",
  async (changed) => {
    const now = Date.now();
    await withFixture(
      async ({ profileId, store, fail }) => {
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
        // The worker reduces current usage rather than this caller's older view.
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
              if (profile.credential.type === "oauth") {
                profile.credential.access = "synthetic-replacement-access";
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
      "personal",
      {
        type: "oauth",
        provider: "openai",
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        expires: now + 3_600_000,
      },
    );
  },
);

it("refuses stale personal credential generations without overwriting current usage", () =>
  withFixture(async ({ profileId, store, succeed, fail }) => {
    const callerBefore = structuredClone(store);
    updateUserModelAuthProfile(profileId, (profile) => {
      profile.credential = tokenCredential("synthetic-replacement-token");
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
  }, "personal"));

it("joins accepted nonblocking embedded bookkeeping before maintenance closes", () =>
  withFixture(async ({ profileId, initial, succeed }) => {
    const maintenance = createOpenClawDatabaseMaintenanceScope();
    const gate = holdWorker(false);
    expect(maintenance.run(succeed)).toBeUndefined();
    let closed = false;
    const closing = maintenance.close().then(() => {
      closed = true;
    });
    try {
      await awaitGateBeforeSettlement(gate.entered, closing, "Premature bookkeeping close");
      expect(closed).toBe(false);
      expect(readUserModelAuthProfile(profileId)).toEqual(initial);
      gate.release();
      await closing;
      expect(readUserModelAuthProfile(profileId)?.usageStats?.lastUsed).toEqual(expect.any(Number));
      expect(closed).toBe(true);
    } finally {
      gate.release();
      gate.restore();
      await closing;
    }
  }, "personal"));

it.each(["sibling rotation", "sibling addition", "selected rotation"] as const)(
  "keeps usage bound to the selected credential after %s",
  (mutation) =>
    withFixture(async (f) => {
      const before = structuredClone(f.store);
      const replacement = structuredClone(before);
      const changedId =
        mutation === "selected rotation"
          ? sharedId
          : mutation === "sibling addition"
            ? "anthropic:added"
            : siblingId;
      replacement.profiles[changedId] = tokenCredential("synthetic-replacement-token");
      const gate = holdWorker();
      const pending = f.fail();
      try {
        await awaitGateBeforeSettlement(gate.entered, pending, "Usage settled before dispatch");
        if (mutation === "selected rotation") {
          // A foreign credential commit does not publish this process's mutation lineage.
          writeAuthProfileJsonCell(
            f.database.db,
            "store",
            f.kind,
            buildPersistedAuthProfileSecretsStore(replacement),
          );
        } else {
          saveAuthProfileStore(replacement, undefined, saveOptions);
        }
        gate.release();
        if (mutation === "selected rotation") {
          await expect(pending).rejects.toThrow(
            "Auth credentials changed during usage preparation",
          );
          expect(loadPersistedAuthProfileStore()?.usageStats).toEqual(before.usageStats);
          expect(f.store).toEqual(before);
        } else {
          await pending;
          const persisted = loadPersistedAuthProfileStore();
          expect(persisted?.usageStats?.[sharedId]).toMatchObject({
            errorCount: 3,
            failureCounts: { auth: 2, timeout: 1 },
            cooldownReason: "timeout",
          });
          expect(f.store.usageStats?.[sharedId]).toEqual(persisted?.usageStats?.[sharedId]);
        }
        expect(loadPersistedAuthProfileStore()?.profiles).toEqual(replacement.profiles);
      } finally {
        gate.release();
        await Promise.allSettled([pending]);
      }
    }),
);

it.each(["personal", "shared"] as const)(
  "preserves the authority error class and refuses a revoked %s write",
  (owner) =>
    withFixture(async (f) => {
      const before = structuredClone(f.store);
      const gate = holdWorker(owner !== "personal");
      const refused = new TypeError("Synthetic auth owner revoked");
      let revoked = false;
      const maintenance = createOpenClawDatabaseMaintenanceScope({
        assertOwnerCurrent() {
          if (revoked) {
            throw refused;
          }
        },
      });
      const pending = maintenance.run(f.fail);
      const rejection = expect(pending).rejects.toBeInstanceOf(TypeError);
      try {
        await awaitGateBeforeSettlement(gate.entered, pending, "Premature usage settlement");
        revoked = true;
        gate.release();
        await rejection;
        await expect(pending).rejects.toThrow(refused.message);
        expect(
          owner === "personal"
            ? readUserModelAuthProfile(f.profileId)
            : loadPersistedAuthProfileStore(),
        ).toEqual(owner === "personal" ? f.initial : f.sharedBefore);
        expect(f.store).toEqual(before);
      } finally {
        revoked = false;
        gate.release();
        if (owner === "personal") {
          gate.restore();
        }
        await Promise.allSettled([pending, rejection]);
        await maintenance.close();
      }
    }, owner),
);

it("does not replay or publish when transport loses a committed usage reply", () =>
  withFixture(async (f) => {
    const before = structuredClone(f.store);
    let writes = 0;
    interceptWorker(async (execute) => {
      writes += 1;
      await execute();
      throw new SqliteWorkerError("Synthetic lost usage reply", "outcome-unknown");
    });
    await expect(f.fail()).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(writes).toBe(1);
    expect(loadPersistedAuthProfileStore()?.usageStats?.[sharedId]).toMatchObject({
      errorCount: 3,
      failureCounts: { auth: 2, timeout: 1 },
    });
    expect(f.store).toEqual(before);
  }));

it("preserves the unreadable-store error identity returned by the worker", () =>
  withFixture(async (f) => {
    f.database.db
      .prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?")
      .run("{", "authProfiles.state");
    await expect(f.fail()).rejects.toBeInstanceOf(AuthProfileStoreUnreadableError);
    expect(readAuthProfileJsonCellText(f.database.db, "state", "shared-state")).toBe("{");
    expect(readAuthProfileJsonCellText(f.database.db, "store", "shared-state")).toBe(f.credentials);
  }));
