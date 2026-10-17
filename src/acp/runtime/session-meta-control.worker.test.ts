import { execFile } from "node:child_process";
import { renameSync } from "node:fs";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { storageProcessTestEntrypoints } from "../../infra/storage-process-runtime.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareAcpSessionControlRead } from "./session-meta-control.js";
import { seedCanonicalAcpSessionMeta } from "./session-meta-fixture.test-support.js";
import { buildAcpDatabaseSessionKey, selectAcpSessionRow } from "./session-meta-keys.js";
import { createAcpMeta, interceptAcpCommit } from "./session-meta-lifecycle.test-support.js";
import { readAcpSessionControlInWorker } from "./session-meta-source.worker.js";
import { upsertAcpSessionMeta, upsertAcpSessionMetaForControl } from "./session-meta-write.js";

const meta = createAcpMeta({ agent: "fixture", runtimeSessionName: "fixture-runtime" });
const controlEntry = {
  sessionId: "same-id",
  lifecycleRevision: "original",
  updatedAt: 100,
  spawnedBy: "agent:main:parent",
};
const controlConfig: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };

async function seedControl(sessionId = controlEntry.sessionId, skipMaintenance = false) {
  const cfg = controlConfig;
  setRuntimeConfigSnapshot(cfg);
  const scope = {
    cfg,
    sessionKey: "agent:main:acp:control",
    agentId: "main",
    ...(skipMaintenance ? { skipMaintenance: true } : {}),
  };
  await replaceSessionEntry(scope, { ...controlEntry, sessionId });
  await upsertAcpSessionMeta({ ...scope, mutate: () => meta, skipMaintenance: true });
  return scope;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
});

it("rechecks same-binding metadata updates and clear through fresh joins without host data SQL", async () => {
  await withOpenClawTestState({ label: "acp-control-fresh" }, async () => {
    const scope = await seedControl("session", true);
    const { cfg } = scope;
    const observe = observeHostDataSql();
    let prepared: Awaited<ReturnType<typeof prepareAcpSessionControlRead>> | undefined;
    try {
      prepared = await prepareAcpSessionControlRead(scope);
      const original = await prepared.readCurrent(cfg);
      expect(original).toMatchObject({ session: { acp: { state: "idle" } } });
      await upsertAcpSessionMeta({ ...scope, mutate: () => ({ ...meta, state: "running" }) });
      expect((await prepared.readCurrent(cfg)).session.acp).toMatchObject({ state: "running" });
      prepared.assertCurrent(cfg);
      await upsertAcpSessionMeta({ ...scope, mutate: () => null });
      expect((await prepared.readCurrent(cfg)).session.acp).toBeUndefined();
      const missing = vi.fn(() => meta);
      await expect(
        upsertAcpSessionMetaForControl({ ...scope, mutate: missing }, original.constraint!),
      ).rejects.toThrow(/no longer present/);
      expect(missing).not.toHaveBeenCalled();
      expect(observe.queries).toEqual([]);
      prepared.release();
      await expect(prepared.readCurrent(cfg)).rejects.toThrow(/unavailable/);
    } finally {
      prepared?.release();
      observe.restore();
    }
  });
});

it.each(["owner", "lifecycle", "shared-source"] as const)(
  "refuses retained control after same-ID %s replacement",
  async (replacement) => {
    await withOpenClawTestState({ label: "acp-control-replacement" }, async (state) => {
      const scope = await seedControl();
      const { cfg } = scope;
      const prepared = await prepareAcpSessionControlRead(scope);
      try {
        if (replacement === "shared-source") {
          const databasePath = resolveOpenClawStateSqlitePath(state.env);
          await closeOpenClawStateDatabaseAsync();
          renameSync(databasePath, `${databasePath}.retired`);
          seedCanonicalAcpSessionMeta({
            sessionKey: buildAcpDatabaseSessionKey(scope.sessionKey, scope.agentId),
            lifecycleRevision: controlEntry.lifecycleRevision,
            meta,
          });
        } else {
          await replaceSessionEntry(scope, {
            ...controlEntry,
            ...(replacement === "owner"
              ? { spawnedBy: "agent:main:successor" }
              : { lifecycleRevision: "successor" }),
          });
        }
        await expect(prepared.readCurrent(cfg)).rejects.toThrow(/changed|unavailable/);
      } finally {
        prepared.release();
      }
    });
  },
);

it("keeps the physical shared-store owner and validates canonical ACP aliases in the worker kernel", async () => {
  await withOpenClawTestState({ label: "acp-control-shared-owner" }, async (state) => {
    const storePath = state.statePath("shared.sqlite");
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, worker: {} } },
      session: { store: storePath },
    };
    setRuntimeConfigSnapshot(cfg);
    openOpenClawAgentDatabase({ agentId: "main", path: storePath });
    const sessionKey = "agent:worker:acp:control";
    const scope = { cfg, storePath, sessionKey, agentId: "worker" };
    const workerEntry = { ...controlEntry, sessionId: "worker-session" };
    await replaceSessionEntry(scope, workerEntry);
    seedCanonicalAcpSessionMeta({
      sessionKey: "agent:WORKER:acp:CONTROL",
      lifecycleRevision: "original",
      meta,
    });
    const prepared = await prepareAcpSessionControlRead(scope);
    try {
      const current = await prepared.readCurrent(cfg);
      expect(current).toMatchObject({
        session: { acp: { state: "idle" } },
        constraint: { source: { agentId: "main" }, agentId: "worker" },
      });
      const constraint = current.constraint!;
      const database = openOpenClawStateDatabase();
      const context = captureOpenClawStateWorkerContext();
      const read = (input = constraint) =>
        runWithSqliteWorkerStateContext(context, () =>
          runOpenClawStateWriteTransaction((db) => readAcpSessionControlInWorker(db, input), {
            database,
          }),
        );
      expect(read().row).toMatchObject({ session_id: "original" });
      const missingKey = "agent:worker:acp:missing";
      const missingMetadataKey = buildAcpDatabaseSessionKey(missingKey, "worker");
      seedCanonicalAcpSessionMeta({
        sessionKey: missingMetadataKey,
        lifecycleRevision: "deleted-lifecycle",
        meta,
      });
      expect(
        read({
          ...constraint,
          sessionKey: missingKey,
          entry: undefined,
          ownerKey: undefined,
          read: { keys: [missingMetadataKey] },
        }).row,
      ).toBeUndefined();
      seedCanonicalAcpSessionMeta({
        sessionKey: "agent:WORKER:acp:CONTROL",
        lifecycleRevision: "successor",
        meta,
      });
      expect(read().row).toBeUndefined();
      await replaceSessionEntry(scope, { ...workerEntry, lifecycleRevision: "successor" });
      expect(() => read()).toThrow(/changed/);
    } finally {
      prepared.release();
    }
  });
});

const originalLifecycle = "original-lifecycle";
it.each([
  ["clear", undefined],
  ["rebind", { session_id: "replacement-lifecycle", state: "running" }],
  ["same-binding", { session_id: originalLifecycle, state: "idle", last_activity_at: 300 }],
  [
    "runtime-rebind",
    {
      session_id: originalLifecycle,
      runtime_session_name: "replacement-runtime",
      state: "running",
      last_activity_at: 200,
    },
  ],
] as const)(
  "rechecks global metadata at controlled commit after an independent %s write",
  async (change, expected) => {
    await withOpenClawTestState({ label: `acp-control-commit-${change}` }, async (state) => {
      const storePath = state.statePath("shared-agent.sqlite");
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { main: {} },
          defaults: { sessionStore: { agentId: "main" } },
        },
        session: { scope: "global", store: storePath },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const scope = { cfg, agentId: "main", sessionKey: "global", skipMaintenance: true };
      await replaceSessionEntry(
        { ...scope, storePath },
        { ...controlEntry, sessionId: "original-id", lifecycleRevision: originalLifecycle },
      );
      const aliasKey = buildAcpDatabaseSessionKey("global", "main");
      seedCanonicalAcpSessionMeta({
        sessionKey: aliasKey,
        lifecycleRevision: originalLifecycle,
        meta,
      });
      const prepared = await prepareAcpSessionControlRead(scope);
      const constraint = {
        ...(await prepared.readCurrent(cfg)).constraint!,
        runtimeLocator: { backend: meta.backend, runtimeSessionName: meta.runtimeSessionName },
      };
      const reached = createDeferredCore();
      const release = createDeferredCore();
      let paused = false;
      const intercepted = interceptAcpCommit(async (execute) => {
        if (!paused) {
          paused = true;
          reached.resolve();
          await release.promise;
        }
        return execute();
      });
      const mutate = vi.fn((current: SessionAcpMeta | undefined) => {
        if (!current) {
          throw new Error("Expected a current ACP row at preparation");
        }
        return { ...current, state: "idle" as const, lastActivityAt: 300 };
      });
      const observe = observeHostDataSql();
      const outcome = upsertAcpSessionMetaForControl({ ...scope, mutate }, constraint).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await awaitGateBeforeSettlement(
          reached.promise,
          outcome,
          "Controlled update settled before its commit gate",
        );
        const moduleUrl = resolveRuntimeWorkerUrl(storageProcessTestEntrypoints.acpMetadataWriter);
        const lifecycleRevision = change === "rebind" ? "replacement-lifecycle" : originalLifecycle;
        const runtimeSessionName =
          change === "runtime-rebind" ? "replacement-runtime" : meta.runtimeSessionName;
        const replacementMeta: SessionAcpMeta = {
          ...meta,
          runtimeSessionName,
          state: "running",
          lastActivityAt: 200,
        };
        const rows = [{ sessionKey: aliasKey, lifecycleRevision, meta: replacementMeta }];
        if (change === "rebind") {
          rows.push({ sessionKey: "global", lifecycleRevision: originalLifecycle, meta });
        }
        const input = {
          mutation:
            change === "clear"
              ? { kind: "upsert", scope, clear: true }
              : { kind: "migration", rows },
        } satisfies Parameters<
          typeof import("./session-meta-process.test-support.js").writeAcpMetadataFromProcess
        >[0];
        const childSource = `
          const { writeAcpMetadataFromProcess } = await import(${JSON.stringify(moduleUrl.href)});
          await writeAcpMetadataFromProcess(${JSON.stringify(input)});
        `;
        await promisify(execFile)(
          process.execPath,
          [
            ...resolveRuntimeWorkerArgv(moduleUrl).slice(0, -1),
            "--input-type=module",
            "--eval",
            childSource,
          ],
          {
            cwd: process.cwd(),
            env: {
              PATH: process.env.PATH,
              OPENCLAW_STATE_DIR: state.env.OPENCLAW_STATE_DIR,
              OPENCLAW_CONFIG_PATH: state.env.OPENCLAW_CONFIG_PATH,
              NODE_ENV: "test",
            },
            timeout: 60_000,
            maxBuffer: 1024 * 1024,
          },
        );
        release.resolve();
        const result = await outcome;
        expect(result.ok).toBe(change === "same-binding");
        if (!result.ok) {
          expect(String(result.error)).toMatch(/ACP.*(metadata|binding|changed)/i);
        }
        expect(mutate).toHaveBeenCalledOnce();
        expect(observe.queries).toEqual([]);
      } finally {
        release.resolve();
        await outcome;
        observe.restore();
        intercepted.mockRestore();
        prepared.release();
      }
      const { db } = openOpenClawStateDatabase();
      const canonical = selectAcpSessionRow(db, buildAcpDatabaseSessionKey("global", "main"));
      if (expected) {
        expect(canonical).toMatchObject(expected);
      } else {
        expect(canonical).toBeUndefined();
      }
    });
  },
);
