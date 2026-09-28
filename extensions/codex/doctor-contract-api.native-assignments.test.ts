import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import {
  clearSessionStoreCacheForTest,
  getSessionEntry,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { ensureCodexAppServerClientRuntime } from "./src/app-server/client-runtime.js";
import { createNativeSubagentAssignmentStore } from "./src/app-server/native-subagent-assignment-store.js";
import {
  codexNativeSubagentHistoryConnectionFingerprint,
  type CodexNativeSubagentHistoryOwner,
} from "./src/app-server/native-subagent-history-owner.js";
import { defaultNativeSubagentMonitorRuntime } from "./src/app-server/native-subagent-monitor-runtime.js";
import { codexNativeSubagentMonitorRuntime } from "./src/app-server/native-subagent-monitor.js";
import { createClient, threadRead } from "./src/app-server/native-subagent-monitor.test-support.js";
import { createParams } from "./src/app-server/run-attempt-test-harness.js";
import {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  createCodexAppServerBindingStore,
  type StoredCodexAppServerBinding,
} from "./src/app-server/session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./src/app-server/session-binding.sqlite.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    clearSessionStoreCacheForTest();
    cleanup();
  }),
);

const identity = {
  kind: "session" as const,
  agentId: "main",
  sessionId: "requester-session",
  sessionKey: "agent:main:upgrade-parent",
};
const binding = {
  threadId: "parent-after-rotation",
  cwd: "/synthetic-workspace",
  appServerRuntimeFingerprint: "synthetic-connection",
};
const bindingKey = bindingStoreKey(identity);
const bindingOptions = {
  namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
  maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  overflowPolicy: "reject-new" as const,
};

function registeredMigration() {
  const migration = stateMigrations.find((entry) => entry.id === "codex-native-task-assignments");
  if (!migration) {
    throw new Error("Codex Doctor did not register native Task assignment migration");
  }
  return migration;
}

function doctorParams() {
  const stateDir = tempDirs.make("openclaw-codex-native-upgrade-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const context: PluginDoctorStateMigrationContext = {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("codex", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
  return {
    config: {},
    env,
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context,
  };
}

function interceptImportCommit(
  context: PluginDoctorStateMigrationContext,
  beforeCommit: () => Promise<void>,
): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      const store = context.openPluginStateKeyedStore<T>(options);
      const withCurrent = store.withCurrent;
      assert(withCurrent, "Fixture requires an authority-bound keyed store");
      return {
        ...store,
        withCurrent(authority: { assertCurrent(): void }) {
          const writer = withCurrent(authority);
          return {
            ...writer,
            async compareAndApply(...args: Parameters<typeof writer.compareAndApply>) {
              await beforeCommit();
              return await writer.compareAndApply(...args);
            },
          };
        },
      };
    },
  };
}

type LegacyTask = {
  id: string;
  runId: string;
  nativeTurnId?: string;
  owner?: CodexNativeSubagentHistoryOwner;
  status?: "running" | "succeeded";
  deliveryStatus?: "pending" | "delivered";
  result?: string;
  ownerKey?: string;
  scopeKind?: string;
};

async function createFixture() {
  const params = doctorParams();
  const storePath = path.join(params.stateDir, "agents", "main", "sessions", "sessions.json");
  const sessionScope = {
    agentId: identity.agentId,
    sessionKey: identity.sessionKey,
    storePath,
    env: params.env,
  };
  await upsertSessionEntry({
    ...sessionScope,
    entry: {
      sessionId: identity.sessionId,
      lifecycleRevision: "requester-revision",
      agentHarnessId: "codex",
      updatedAt: 1,
    },
  });
  const stored: StoredCodexAppServerBinding = {
    version: 1,
    state: "active",
    sessionId: identity.sessionId,
    binding,
  };
  const store =
    params.context.openPluginStateKeyedStore<StoredCodexAppServerBinding>(bindingOptions);
  await store.register(bindingKey, stored);
  const connectionFingerprint = codexNativeSubagentHistoryConnectionFingerprint(binding);
  if (!connectionFingerprint) {
    throw new Error("Fixture requires a native connection identity");
  }
  const owner: CodexNativeSubagentHistoryOwner = {
    parentThreadId: "parent-before-rotation",
    sessionId: identity.sessionId,
    lifecycleRevision: "requester-revision",
    connectionFingerprint,
  };
  const { db } = openOpenClawStateDatabase({ env: params.env });
  const insert = db.prepare(`
    INSERT INTO task_runs (
      task_id, runtime, task_kind, source_id, requester_session_key, owner_key,
      scope_kind, agent_id, requester_agent_id, run_id, task, status,
      delivery_status, notify_policy, created_at, ended_at, terminal_summary, detail_json
    ) VALUES (?, 'subagent', 'codex-native', ?, ?, ?, ?, 'main', 'main', ?,
      'Synthetic released native work', ?, ?, 'silent', 100, ?, ?, ?)
  `);
  return {
    params,
    store,
    owner,
    stored,
    sessionScope,
    seed(task: LegacyTask) {
      insert.run(
        task.id,
        task.runId,
        identity.sessionKey,
        task.ownerKey ?? identity.sessionKey,
        task.scopeKind ?? "session",
        task.runId,
        task.status ?? "running",
        task.deliveryStatus ?? "pending",
        task.result === undefined ? null : 200,
        task.result ?? null,
        JSON.stringify({
          ...(task.owner ? { nativeHistory: task.owner } : {}),
          ...(task.nativeTurnId ? { nativeTurnId: task.nativeTurnId } : {}),
        }),
      );
    },
    rows: () => db.prepare("SELECT * FROM task_runs ORDER BY task_id").all(),
    runtime: createCodexAppServerBindingStore(
      createCodexSqliteTestBindingStateStore({
        ...bindingOptions,
        env: params.env,
      }),
    ),
  };
}

describe("Codex native Task assignment upgrade", () => {
  it("imports released initial and promoted follow-up work once across native rotation and clear", async () => {
    const fixture = await createFixture();
    fixture.seed({
      id: "legacy-initial",
      runId: "codex-thread:initial-child",
      owner: fixture.owner,
      status: "succeeded",
      result: "Initial result retained after native history pruning",
    });
    fixture.seed({
      id: "legacy-followup",
      runId: "codex-thread:followup-child:turn:followup-turn",
      nativeTurnId: "followup-turn",
      owner: fixture.owner,
    });
    fixture.seed({
      id: "already-acknowledged",
      runId: "codex-thread:acknowledged-child",
      owner: fixture.owner,
      status: "succeeded",
      deliveryStatus: "delivered",
      result: "Already delivered",
    });
    const sourceRows = fixture.rows();
    const migration = registeredMigration();

    expect(await migration.detectLegacyState(fixture.params)).not.toBeNull();
    const imported = await migration.migrateLegacyState(fixture.params);

    expect(imported.warnings).toEqual([]);
    expect(imported.changes.length).toBeGreaterThan(0);
    const currentOwner = { ...fixture.owner, parentThreadId: binding.threadId };
    const assignments = fixture.runtime.readNativeSubagentAssignments!(identity, currentOwner);
    expect(assignments).toEqual(
      expect.arrayContaining([
        {
          runId: "codex-thread:initial-child",
          childThreadId: "initial-child",
          nativeParentThreadId: "parent-before-rotation",
          owner: fixture.owner,
          recordedCompletion: {
            childThreadId: "initial-child",
            status: "succeeded",
            statusLabel: "recorded_task_result",
            result: "Initial result retained after native history pruning",
            completedAt: 200,
          },
        },
        {
          runId: "codex-thread:followup-child:turn:followup-turn",
          childThreadId: "followup-child",
          nativeTurnId: "followup-turn",
          nativeParentThreadId: "parent-before-rotation",
          owner: fixture.owner,
        },
      ]),
    );
    expect(assignments).toHaveLength(2);
    const importedState = await fixture.store.lookup(bindingKey);
    expect(importedState).toMatchObject({
      nativeSubagentTaskImport: {
        version: 1,
        taskIds: expect.arrayContaining(["legacy-initial", "legacy-followup"]),
      },
    });
    await withEnvAsync({ OPENCLAW_STATE_DIR: fixture.params.stateDir }, async () => {
      const deliver = vi.fn(defaultNativeSubagentMonitorRuntime.deliverAgentHarnessCompletion);
      deliver.mockImplementation(async ({ completionCustody }) => {
        assert(completionCustody?.isCurrent());
        return { delivered: true, path: "direct" };
      });
      for (const attempt of ["recover", "repeat"]) {
        const params = createParams(
          path.join(fixture.params.stateDir, "parent.jsonl"),
          fixture.params.stateDir,
          {
            ...identity,
            runId: `upgrade-${attempt}`,
          },
        );
        params.agentId = identity.agentId;
        const host = await createAdmittedHostCapabilityTestFixture(params, {
          gatewayContext: true,
        });
        const client = createClient();
        ensureCodexAppServerClientRuntime(client.client, { agentDir: fixture.params.stateDir });
        const initial = threadRead({
          childThreadId: "initial-child",
          parentThreadId: fixture.owner.parentThreadId,
        });
        initial.thread.forkedFromId = fixture.owner.parentThreadId;
        initial.thread.turns = [];
        client.setThreadRead("initial-child", initial);
        client.setThreadRead(
          "followup-child",
          threadRead({
            childThreadId: "followup-child",
            parentThreadId: fixture.owner.parentThreadId,
            turnId: "followup-turn",
            result: "Recovered follow-up result",
            resultPhase: "final_answer",
          }),
        );
        const registered =
          createDeferred<Awaited<ReturnType<typeof codexNativeSubagentMonitorRuntime.register>>>();
        try {
          assert(host.agentHarnessCompletionScope);
          const tool = host.hostCapabilities.bindToolSurface([
            {
              name: "recover_native_assignments",
              label: "Recover native assignments",
              description: "Recover accepted native work",
              parameters: Type.Object({}),
              execute: async () => {
                registered.resolve(
                  await codexNativeSubagentMonitorRuntime.register({
                    client: client.client,
                    parentThreadId: binding.threadId,
                    requesterSessionKey: identity.sessionKey,
                    completionScope: host.agentHarnessCompletionScope,
                    historyOwner: currentOwner,
                    assignmentStore: createNativeSubagentAssignmentStore({
                      bindingStore: fixture.runtime,
                      identity,
                      owner: currentOwner,
                    }),
                    runtime: {
                      ...defaultNativeSubagentMonitorRuntime,
                      deliverAgentHarnessCompletion: deliver,
                    },
                  }),
                );
                return { content: [{ type: "text", text: "registered" }], details: {} };
              },
            },
          ])[0];
          assert(tool);
          await host.runWithGatewayScope(() => tool.execute("recover", {}));
          const parent = await registered.promise;
          await parent.ready;
          await parent.unregister();
          expect(deliver.mock.calls.map(([request]) => request.result).toSorted()).toEqual([
            "Initial result retained after native history pruning",
            "Recovered follow-up result",
          ]);
        } finally {
          client.close();
          host.closeHost();
          host.closeAdmission();
          host.closeGateway();
        }
        await migration.migrateLegacyState(fixture.params);
      }
    });
    await migration.migrateLegacyState(fixture.params);
    expect(fixture.runtime.readNativeSubagentAssignments!(identity, currentOwner)).toEqual([]);

    await expect(fixture.runtime.mutate(identity, { kind: "clear" })).resolves.toBe(true);
    const cleared = (await fixture.store.entries()).find((entry) => entry.key === bindingKey);
    expect(cleared).toMatchObject({
      value: {
        state: "cleared",
        nativeSubagentTaskImport: {
          version: 1,
          taskIds: expect.arrayContaining(["legacy-initial", "legacy-followup"]),
        },
      },
    });
    expect(cleared?.expiresAt).toBeUndefined();
    await fixture.runtime.withLease(identity, async () => undefined);
    await expect(fixture.store.lookup(bindingKey)).resolves.toMatchObject({
      nativeSubagentTaskImport: {
        version: 1,
        taskIds: expect.arrayContaining(["legacy-initial", "legacy-followup"]),
      },
    });
    await expect(fixture.runtime.mutate(identity, { kind: "set", binding })).resolves.toBe(true);
    await migration.migrateLegacyState(fixture.params);
    expect(fixture.runtime.readNativeSubagentAssignments!(identity, currentOwner)).toEqual([]);
    await expect(fixture.runtime.resetSessionGeneration(identity)).resolves.toBe("applied");
    const reset = (await fixture.store.entries()).find((entry) => entry.key === bindingKey);
    expect(reset?.value).toMatchObject({
      state: "cleared",
      nativeSubagentTaskImport: {
        version: 1,
        taskIds: expect.arrayContaining(["legacy-initial", "legacy-followup"]),
      },
    });
    expect(reset?.expiresAt).toBeUndefined();
    await fixture.runtime.withLease(identity, async () => undefined);
    await expect(fixture.store.lookup(bindingKey)).resolves.toMatchObject({
      nativeSubagentTaskImport: {
        version: 1,
        taskIds: expect.arrayContaining(["legacy-initial", "legacy-followup"]),
      },
    });
    await expect(fixture.runtime.mutate(identity, { kind: "set", binding })).resolves.toBe(true);
    await migration.migrateLegacyState(fixture.params);
    expect(fixture.runtime.readNativeSubagentAssignments!(identity, currentOwner)).toEqual([]);
    expect(fixture.rows()).toEqual(sourceRows);
  });

  it.each(["missing", "session", "lifecycle", "connection", "owner-key", "scope"] as const)(
    "warns without changing source, session, or binding for a %s ownership stamp",
    async (mismatch) => {
      const fixture = await createFixture();
      const owner = { ...fixture.owner };
      if (mismatch === "session") {
        owner.sessionId = "previous-physical-session";
      }
      if (mismatch === "lifecycle") {
        owner.lifecycleRevision = "previous-revision";
      }
      if (mismatch === "connection") {
        owner.connectionFingerprint = "0".repeat(64);
      }
      fixture.seed({
        id: "unresolved-legacy-child",
        runId: "codex-thread:unresolved-child",
        ...(mismatch === "missing" ? {} : { owner }),
        ...(mismatch === "owner-key" ? { ownerKey: "agent:main:other" } : {}),
        ...(mismatch === "scope" ? { scopeKind: "system" } : {}),
      });
      const rows = fixture.rows();
      const session = getSessionEntry(fixture.sessionScope);

      const result = await registeredMigration().migrateLegacyState(fixture.params);

      expect(result.changes).toEqual([]);
      expect(result.warningDisposition).toBe("recoverable");
      expect(result.warnings.join("\n")).toContain("unresolved-legacy-child");
      if (mismatch === "missing") {
        expect(result.warnings.join("\n")).toMatch(/owner|session|connection|nativeHistory/i);
        expect(result.warnings.join("\n")).toContain("codex-thread:unresolved-child");
      }
      await expect(fixture.store.lookup(bindingKey)).resolves.toEqual(fixture.stored);
      expect(getSessionEntry(fixture.sessionScope)).toEqual(session);
      expect(fixture.rows()).toEqual(rows);
    },
  );

  it("does not resurrect a pending duplicate of an acknowledged native assignment", async () => {
    const fixture = await createFixture();
    for (const deliveryStatus of ["pending", "delivered"] as const) {
      fixture.seed({
        id: `duplicate-${deliveryStatus}`,
        runId: "codex-thread:duplicate-child",
        owner: fixture.owner,
        status: "succeeded",
        deliveryStatus,
        result: "Previously acknowledged result",
      });
    }
    const sourceRows = fixture.rows();

    const result = await registeredMigration().migrateLegacyState(fixture.params);

    expect(result.changes).toEqual([]);
    expect(result.warningDisposition).toBe("recoverable");
    expect(result.warnings.join("\n")).toContain("duplicate-pending");
    expect(result.warnings.join("\n")).toMatch(/duplicate/i);
    await expect(fixture.store.lookup(bindingKey)).resolves.toEqual(fixture.stored);
    expect(fixture.rows()).toEqual(sourceRows);
  });

  it("preserves source work and newer binding state when the migration CAS loses", async () => {
    const fixture = await createFixture();
    fixture.seed({ id: "racing-task", runId: "codex-thread:racing-child", owner: fixture.owner });
    const sourceRows = fixture.rows();
    const replacement: StoredCodexAppServerBinding = {
      ...fixture.stored,
      binding: { ...binding, threadId: "newer-native-parent" },
    };
    let raced = false;
    const context = interceptImportCommit(fixture.params.context, async () => {
      if (!raced) {
        raced = true;
        await fixture.store.register(bindingKey, replacement);
      }
    });

    const result = await registeredMigration().migrateLegacyState({ ...fixture.params, context });

    expect(raced).toBe(true);
    expect(result.changes).toEqual([]);
    expect(result.warningDisposition).toBe("recoverable");
    expect(result.warnings.length).toBeGreaterThan(0);
    await expect(fixture.store.lookup(bindingKey)).resolves.toEqual(replacement);
    expect(fixture.rows()).toEqual(sourceRows);
  });

  it("rejects import when the requester is replaced while its binding CAS is awaiting work", async () => {
    const fixture = await createFixture();
    fixture.seed({
      id: "replaced-task",
      runId: "codex-thread:replaced-child",
      owner: fixture.owner,
    });
    const sourceRows = fixture.rows();
    const original = getSessionEntry(fixture.sessionScope);
    assert(original, "Fixture requires a current requester session");
    const successor = {
      ...original,
      sessionId: "successor-session",
      lifecycleRevision: "successor-revision",
    };
    let replaced = false;
    const context = interceptImportCommit(fixture.params.context, async () => {
      if (!replaced) {
        replaced = true;
        await upsertSessionEntry({ ...fixture.sessionScope, entry: successor });
      }
    });

    const result = await registeredMigration().migrateLegacyState({ ...fixture.params, context });

    expect(replaced).toBe(true);
    expect(result.changes).toEqual([]);
    expect(result.warningDisposition).toBe("recoverable");
    expect(result.warnings.join("\n")).toMatch(/ownership no longer matches/);
    await expect(fixture.store.lookup(bindingKey)).resolves.toEqual(fixture.stored);
    expect(getSessionEntry(fixture.sessionScope)).toMatchObject(successor);
    expect(fixture.rows()).toEqual(sourceRows);
  });

  it("declares its SQLite backup without creating missing state during detection", async () => {
    const params = doctorParams();
    const migration = registeredMigration();
    const contents = await fs.readdir(params.stateDir);
    const resources = await migration.collectBackupResources?.(params);

    expect(resources).toContainEqual({
      path: path.join(params.stateDir, "state", "openclaw.sqlite"),
      kind: "sqlite",
    });
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    expect(await fs.readdir(params.stateDir)).toEqual(contents);
  });
});
