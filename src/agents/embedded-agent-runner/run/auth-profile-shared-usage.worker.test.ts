import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { writeConfigMachineState } from "../../../state/config-machine-state-write.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../../state/openclaw-state-db-async-lifecycle.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import * as workerStore from "../../../state/openclaw-state-worker-store.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { noteCommittedSharedAuthStoreOwnership } from "../../auth-profiles/path-resolve.js";
import { loadPersistedAuthProfileStore } from "../../auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../auth-profiles/runtime-snapshots.js";
import {
  readAuthProfileJsonCellText,
  SHARED_AUTH_STORE_STATE_KEY,
} from "../../auth-profiles/sqlite-json.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "../../auth-profiles/store-runtime.js";
import { AuthProfileStoreUnreadableError } from "../../auth-profiles/store-unreadable-error.js";
import type { AuthProfileStore } from "../../auth-profiles/types.js";
import { markEmbeddedRunAuthProfileSuccess } from "./auth-profile-success.js";
import { createEmbeddedRunFailoverRetryController } from "./failover-retry-controller.js";

const provider = "anthropic";
const profileId = "anthropic:used";
const siblingId = "anthropic:sibling";
type Owner = "shared" | "inherited" | "agent";

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
  clearRuntimeConfigSnapshot();
});

async function fixture(state: OpenClawTestState, owner: Owner = "shared") {
  const config = { agents: { list: [{ id: "main", default: true }, { id: "voice" }] } };
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
      [profileId]: { type: "token", provider, token: "synthetic-shared-token" },
      [siblingId]: { type: "token", provider, token: "synthetic-sibling-token" },
    },
    lastGood: { [provider]: siblingId },
    usageStats: {
      [profileId]: {
        lastUsed: 17,
        errorCount: 2,
        failureCounts: { auth: 2 },
        lastFailureAt: Date.now(),
        disabledUntil: Date.now() + 60_000,
        disabledReason: "auth",
      },
    },
  };
  const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };
  saveAuthProfileStore(initial, undefined, saveOptions);
  const agentDir = state.agentDir(owner === "shared" ? "main" : "voice");
  if (owner !== "shared") {
    const local = structuredClone(initial);
    if (owner === "agent") {
      local.profiles[profileId] = { type: "token", provider, token: "synthetic-agent-token" };
    } else {
      delete local.profiles[profileId];
      delete local.usageStats;
    }
    saveAuthProfileStore(local, agentDir, saveOptions);
  }
  const store = ensureAuthProfileStore(agentDir);
  const sharedBefore = loadPersistedAuthProfileStore();
  const localBefore = loadPersistedAuthProfileStore(agentDir);
  const ownerDir = owner === "agent" ? agentDir : undefined;
  const database =
    owner === "agent"
      ? openOpenClawAgentDatabase({ agentId: "voice", env: state.env })
      : openOpenClawStateDatabase();
  const kind: "agent" | "shared-state" = owner === "agent" ? "agent" : "shared-state";
  const credentials = readAuthProfileJsonCellText(database.db, "store", kind);
  const controller = createEmbeddedRunFailoverRetryController({
    runParams: {
      runId: "shared-usage-run",
      sessionId: "shared-usage-session",
      sessionFile: state.path("synthetic-session.jsonl"),
      workspaceDir: state.workspaceDir,
      prompt: "synthetic shared-account failure",
      timeoutMs: 60_000,
      config,
    },
    provider,
    modelId: "synthetic-model",
    globalLane: "shared-usage-test",
    agentDir,
    fallbackConfigured: false,
    profileFailureStore: store,
    getLastProfileId: () => profileId,
    getSessionId: () => "shared-usage-session",
    harnessOwnsTransport: () => false,
    getRuntimeAuthOwnerId: () => "embedded",
    getApiKeyInfo: () => null,
    advanceAuthProfile: async () => false,
  });
  return {
    store,
    database,
    kind,
    credentials,
    ownerDir,
    agentDir,
    sharedBefore,
    localBefore,
    fail: () => controller.maybeMarkAuthProfileFailure({ profileId, reason: "timeout" }),
    succeed: () =>
      markEmbeddedRunAuthProfileSuccess({
        profileId,
        profileStore: store,
        provider,
        agentDir: owner === "shared" ? undefined : agentDir,
        runId: "shared-usage-run",
        sessionId: "shared-usage-session",
      }),
  };
}

function interceptUsageCommand(intercept: (execute: () => Promise<unknown>) => Promise<unknown>) {
  const original = workerStore.runOpenClawStateWorkerOperation;
  return vi.spyOn(workerStore, "runOpenClawStateWorkerOperation").mockImplementation(
    new Proxy(original, {
      apply(target, receiver, args: Parameters<typeof original>) {
        const [context, operation, options] = args;
        return Reflect.apply(target, receiver, [
          context,
          (scope: Parameters<typeof operation>[0]) =>
            operation({
              execute: new Proxy(scope.execute, {
                apply(execute, receiver, args: Parameters<typeof scope.execute>) {
                  return args[0].type === "authProfiles.usage"
                    ? intercept(() => Reflect.apply(execute, receiver, args))
                    : Reflect.apply(execute, receiver, args);
                },
              }),
            }),
          options,
        ]);
      },
    }),
  );
}

it.each<Owner>(["shared", "inherited", "agent"])(
  "records embedded success then failover failure in the %s owner without caller SQL",
  async (owner) => {
    await withOpenClawTestState(
      { label: "shared-usage-worker", scenario: "minimal" },
      async (state) => {
        const f = await fixture(state, owner);
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
        const persisted = loadPersistedAuthProfileStore(f.ownerDir);
        expect(persisted?.usageStats?.[profileId]).toMatchObject({
          lastUsed: owner === "inherited" ? 17 : expect.any(Number),
          errorCount: 1,
          failureCounts: { timeout: 1 },
          cooldownReason: "timeout",
        });
        expect(persisted?.usageStats?.[profileId]?.disabledUntil).toBeUndefined();
        expect(persisted?.lastGood?.[provider]).toBe(owner === "inherited" ? siblingId : profileId);
        expect(f.store.usageStats?.[profileId]).toEqual(persisted?.usageStats?.[profileId]);
        expect(readAuthProfileJsonCellText(f.database.db, "store", f.kind)).toBe(f.credentials);
        if (owner === "agent") {
          expect(loadPersistedAuthProfileStore()).toEqual(f.sharedBefore);
        } else if (owner === "inherited") {
          expect(loadPersistedAuthProfileStore(f.agentDir)).toEqual(f.localBefore);
          expect(f.store.lastGood?.[provider]).toBe(siblingId);
        }
      },
    );
  },
);

it("preserves the live authority error class and refuses the worker write", async () => {
  await withOpenClawTestState(
    { label: "shared-usage-refusal", scenario: "minimal" },
    async (state) => {
      const f = await fixture(state);
      const before = structuredClone(f.store);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const refused = new TypeError("Synthetic shared auth owner revoked");
      let revoked = false;
      const maintenance = createOpenClawDatabaseMaintenanceScope({
        assertOwnerCurrent() {
          if (revoked) {
            throw refused;
          }
        },
      });
      interceptUsageCommand(async (execute) => {
        entered.resolve();
        await release.promise;
        return execute();
      });
      const pending = maintenance.run(f.fail);
      const rejection = expect(pending).rejects.toBeInstanceOf(TypeError);
      try {
        await awaitGateBeforeSettlement(entered.promise, pending, "Usage settled before dispatch");
        revoked = true;
        release.resolve();
        await rejection;
        await expect(pending).rejects.toThrow(refused.message);
        expect(loadPersistedAuthProfileStore()).toEqual(f.sharedBefore);
        expect(f.store).toEqual(before);
      } finally {
        revoked = false;
        release.resolve();
        await Promise.allSettled([pending, rejection]);
        await maintenance.close();
      }
    },
  );
});

it("does not replay or publish when transport loses a committed usage reply", async () => {
  await withOpenClawTestState(
    { label: "shared-usage-unknown", scenario: "minimal" },
    async (state) => {
      const f = await fixture(state);
      const before = structuredClone(f.store);
      let writes = 0;
      interceptUsageCommand(async (execute) => {
        writes += 1;
        await execute();
        throw new SqliteWorkerError("Synthetic lost usage reply", "outcome-unknown");
      });
      await expect(f.fail()).rejects.toMatchObject({ code: "outcome-unknown" });
      expect(writes).toBe(1);
      expect(loadPersistedAuthProfileStore()?.usageStats?.[profileId]).toMatchObject({
        errorCount: 3,
        failureCounts: { auth: 2, timeout: 1 },
      });
      expect(f.store).toEqual(before);
    },
  );
});

it("preserves the unreadable-store error identity returned by the worker", async () => {
  await withOpenClawTestState(
    { label: "shared-usage-unreadable", scenario: "minimal" },
    async (state) => {
      const f = await fixture(state);
      f.database.db
        .prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?")
        .run("{", "authProfiles.state");
      await expect(f.fail()).rejects.toBeInstanceOf(AuthProfileStoreUnreadableError);
      expect(readAuthProfileJsonCellText(f.database.db, "state", "shared-state")).toBe("{");
      expect(readAuthProfileJsonCellText(f.database.db, "store", "shared-state")).toBe(
        f.credentials,
      );
    },
  );
});
