import { execFile } from "node:child_process";
import { renameSync } from "node:fs";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
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
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareAcpSessionControlRead } from "./session-meta-control.js";
import { seedCanonicalAcpSessionMeta } from "./session-meta-fixture.test-support.js";
import { buildAcpDatabaseSessionKey, selectAcpSessionRow } from "./session-meta-keys.js";
import { readAcpSessionControlInWorker } from "./session-meta-source.worker.js";
import { upsertAcpSessionMeta, upsertAcpSessionMetaForControl } from "./session-meta-write.js";

const meta: SessionAcpMeta = {
  backend: "fixture",
  agent: "fixture",
  runtimeSessionName: "fixture-runtime",
  mode: "persistent",
  state: "idle",
  lastActivityAt: 100,
};

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
});

it("rechecks same-binding metadata updates and clear through fresh joins without host data SQL", async () => {
  await withOpenClawTestState({ label: "acp-control-fresh" }, async () => {
    const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
    const scope = {
      cfg,
      sessionKey: "agent:main:acp:control",
      agentId: "main",
      skipMaintenance: true,
    };
    await replaceSessionEntry(scope, {
      sessionId: "session",
      lifecycleRevision: "original",
      updatedAt: 100,
      spawnedBy: "agent:main:parent",
    });
    await upsertAcpSessionMeta({ ...scope, mutate: () => meta });
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
      const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
      const scope = { cfg, sessionKey: "agent:main:acp:control", agentId: "main" };
      const entry = {
        sessionId: "same-id",
        lifecycleRevision: "original",
        updatedAt: 100,
        spawnedBy: "agent:main:parent",
      };
      await replaceSessionEntry(scope, entry);
      await upsertAcpSessionMeta({ ...scope, mutate: () => meta, skipMaintenance: true });
      const prepared = await prepareAcpSessionControlRead(scope);
      try {
        if (replacement === "shared-source") {
          const databasePath = resolveOpenClawStateSqlitePath(state.env);
          await closeOpenClawStateDatabaseAsync();
          renameSync(databasePath, `${databasePath}.retired`);
          seedCanonicalAcpSessionMeta({
            sessionKey: buildAcpDatabaseSessionKey(scope.sessionKey, scope.agentId),
            lifecycleRevision: entry.lifecycleRevision,
            meta,
          });
        } else {
          await replaceSessionEntry(scope, {
            ...entry,
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
    openOpenClawAgentDatabase({ agentId: "main", path: storePath });
    const sessionKey = "agent:worker:acp:control";
    const scope = { cfg, storePath, sessionKey, agentId: "worker" };
    await replaceSessionEntry(scope, {
      sessionId: "worker-session",
      lifecycleRevision: "original",
      updatedAt: 100,
      spawnedBy: "agent:main:parent",
    });
    seedCanonicalAcpSessionMeta({
      sessionKey: "agent:WORKER:acp:CONTROL",
      lifecycleRevision: "original",
      meta,
    });
    const prepared = await prepareAcpSessionControlRead(scope);
    try {
      const current = await prepared.readCurrent(cfg);
      expect(current.session.acp).toMatchObject({ state: "idle" });
      const constraint = current.constraint!;
      expect(constraint.source.agentId).toBe("main");
      expect(constraint.agentId).toBe("worker");
      const database = openOpenClawStateDatabase();
      const context = captureOpenClawStateWorkerContext();
      const read = () =>
        runWithSqliteWorkerStateContext(context, () =>
          runOpenClawStateWriteTransaction((db) => readAcpSessionControlInWorker(db, constraint), {
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
        runWithSqliteWorkerStateContext(context, () =>
          runOpenClawStateWriteTransaction(
            (db) =>
              readAcpSessionControlInWorker(db, {
                ...constraint,
                sessionKey: missingKey,
                entry: undefined,
                ownerKey: undefined,
                read: { keys: [missingMetadataKey] },
              }),
            { database },
          ),
        ).row,
      ).toBeUndefined();
      seedCanonicalAcpSessionMeta({
        sessionKey: "agent:WORKER:acp:CONTROL",
        lifecycleRevision: "successor",
        meta,
      });
      expect(read().row).toBeUndefined();
      await replaceSessionEntry(scope, {
        sessionId: "worker-session",
        lifecycleRevision: "successor",
        updatedAt: 100,
        spawnedBy: "agent:main:parent",
      });
      expect(read).toThrow(/changed/);
    } finally {
      prepared.release();
    }
  });
});

it.each(["clear", "rebind", "same-binding", "runtime-rebind"] as const)(
  "rechecks global metadata at controlled commit after an independent %s write",
  async (change) => {
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
      const scope = { cfg, agentId: "main", sessionKey: "global", skipMaintenance: true };
      await replaceSessionEntry(
        { ...scope, storePath },
        {
          sessionId: "original-id",
          lifecycleRevision: "original-lifecycle",
          updatedAt: 100,
          spawnedBy: "agent:main:parent",
        },
      );
      const aliasKey = buildAcpDatabaseSessionKey("global", "main");
      seedCanonicalAcpSessionMeta({
        sessionKey: aliasKey,
        lifecycleRevision: "original-lifecycle",
        meta,
      });
      const prepared = await prepareAcpSessionControlRead(scope);
      const constraint = {
        ...(await prepared.readCurrent(cfg)).constraint!,
        runtimeLocator: { backend: meta.backend, runtimeSessionName: meta.runtimeSessionName },
      };
      const reached = createDeferredCore();
      const release = createDeferredCore();
      const original = stateWorker.runOpenClawStateWorkerOperation;
      let paused = false;
      const intercepted = vi
        .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
        .mockImplementation((context, operation, options) =>
          original(
            context,
            (worker) =>
              operation({
                ...worker,
                execute: new Proxy(worker.execute, {
                  apply(execute, receiver, args: Parameters<typeof worker.execute>) {
                    if (args[0].type === "acp.commitMutation" && !paused) {
                      paused = true;
                      reached.resolve();
                      return release.promise.then(() => Reflect.apply(execute, receiver, args));
                    }
                    return Reflect.apply(execute, receiver, args);
                  },
                }),
              }),
            options,
          ),
        );
      const mutate = vi.fn((current: SessionAcpMeta | undefined) => {
        if (!current) {
          throw new Error("Expected a current ACP row at preparation");
        }
        return { ...current, state: "idle" as const, lastActivityAt: 300 };
      });
      const observe = observeHostDataSql();
      const pending = upsertAcpSessionMetaForControl({ ...scope, mutate }, constraint);
      const outcome = pending.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await Promise.race([
          reached.promise,
          outcome.then(() => {
            throw new Error("Controlled update settled before its commit gate");
          }),
        ]);
        const moduleUrl = resolveRuntimeWorkerUrl(storageProcessTestEntrypoints.acpMetadataWriter);
        const input = {
          mutation:
            change === "clear"
              ? { kind: "upsert", scope, clear: true }
              : {
                  kind: "migration",
                  rows: [
                    {
                      sessionKey: aliasKey,
                      lifecycleRevision:
                        change === "same-binding" || change === "runtime-rebind"
                          ? "original-lifecycle"
                          : "replacement-lifecycle",
                      meta: {
                        ...meta,
                        runtimeSessionName:
                          change === "runtime-rebind"
                            ? "replacement-runtime"
                            : meta.runtimeSessionName,
                        state: "running",
                        lastActivityAt: 200,
                      },
                    },
                    ...(change === "rebind"
                      ? [{ sessionKey: "global", lifecycleRevision: "original-lifecycle", meta }]
                      : []),
                  ],
                },
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
      if (change === "same-binding") {
        expect(canonical).toMatchObject({
          session_id: "original-lifecycle",
          state: "idle",
          last_activity_at: 300,
        });
      } else if (change === "runtime-rebind") {
        expect(canonical).toMatchObject({
          session_id: "original-lifecycle",
          runtime_session_name: "replacement-runtime",
          state: "running",
          last_activity_at: 200,
        });
      } else if (change === "rebind") {
        expect(canonical).toMatchObject({ session_id: "replacement-lifecycle", state: "running" });
      } else {
        expect(canonical).toBeUndefined();
      }
    });
  },
);
