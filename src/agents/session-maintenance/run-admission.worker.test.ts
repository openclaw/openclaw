import { copyFileSync, renameSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createTestFollowupRun } from "../../auto-reply/reply/agent-runner.test-fixtures.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import * as entryReads from "../../config/sessions/session-entry-read-runtime.js";
import { runExclusiveSessionStoreWrite } from "../../config/sessions/store-writer.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import * as sessionLifecycle from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db-registry.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { waitForSessionMaintenance } from "./coordinator.js";
import { scheduleSessionMaintenance } from "./run.js";

const memory = vi.hoisted(() => ({
  runMemoryFlushIfNeeded: vi.fn(async () => ({})),
  runSessionCompactionIfNeeded: vi.fn(async () => {}),
}));
// mock-isolation: Admission uses real stores and workers; optional model/persistence effects stay inert.
vi.mock("../command/runtime-loaders.js", () => ({
  loadAgentRunnerMemoryRuntime: async () => memory,
  loadSessionStoreRuntime: () => import("../command/session-store.runtime.js"),
}));

it("rejects a replacement database while waiting for the foreground owner", async () => {
  await withOpenClawTestState({ label: "maintenance-worker-source" }, async ({ env, path }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:maintenance-source";
    const entry = { sessionId: "maintenance-source", lifecycleRevision: "initial", updatedAt: 1 };
    writeSessionEntry(database, sessionKey, entry);
    await closeOpenClawAgentDatabaseByPathAsync(database.path);
    const replacementPath = path("replacement.sqlite");
    copyFileSync(database.path, replacementPath);
    const predecessor = createDeferred<boolean>();
    const followupRun = createTestFollowupRun({ sessionKey, sessionId: entry.sessionId });
    const request = {
      prepared: { cfg: {}, sessionKey, storePath: database.path, timeoutMs: 60_000 },
      followupRun,
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      startedAt: Date.now(),
    };
    const schedule = (afterOwnerSettles?: Promise<boolean>) =>
      withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: createEmptyPluginRegistry(), isWebchatConnect: () => false },
        () => scheduleSessionMaintenance(request, afterOwnerSettles),
      );
    memory.runMemoryFlushIfNeeded.mockClear();
    memory.runSessionCompactionIfNeeded.mockClear();
    try {
      schedule(predecessor.promise);
      renameSync(database.path, path("original.sqlite"));
      renameSync(replacementPath, database.path);
      expect(
        await entryReads.readSessionEntryReadOnlyInWorker({
          agentId: "main",
          storePath: database.path,
          sessionKey,
          env,
        }),
      ).toMatchObject(entry);
      predecessor.resolve(true);
      await waitForSessionMaintenance(sessionKey);
      expect(memory.runMemoryFlushIfNeeded).not.toHaveBeenCalled();
      expect(memory.runSessionCompactionIfNeeded).not.toHaveBeenCalled();
      schedule();
      await waitForSessionMaintenance(sessionKey);
      expect(memory.runMemoryFlushIfNeeded).toHaveBeenCalledOnce();
      expect(memory.runSessionCompactionIfNeeded).toHaveBeenCalledOnce();
    } finally {
      predecessor.resolve(false);
      await waitForSessionMaintenance(sessionKey);
      memory.runMemoryFlushIfNeeded.mockClear();
      memory.runSessionCompactionIfNeeded.mockClear();
    }
  });
});

it.for(["lifecycle", "logical source"] as const)(
  "rechecks maintenance %s after the writer barrier without caller-thread session SQL",
  async (change, { signal }) => {
    await withOpenClawTestState(
      { label: "maintenance-worker-admission" },
      async ({ env, path }) => {
        const database = openOpenClawAgentDatabase({
          agentId: "main",
          env,
          ...(change === "logical source" ? { path: path("family.main.sqlite") } : {}),
        });
        const sessionKey = "agent:main:maintenance-worker";
        const storePath = change === "logical source" ? path("family.json") : database.path;
        const scope = { agentId: "main", storePath, sessionKey, env };
        const originalIdentity = readDatabasePathIdentitySync(database.path);
        const entry = {
          sessionId: "maintenance-worker",
          lifecycleRevision: "initial",
          updatedAt: 1,
          label: "original",
        };
        writeSessionEntry(database, sessionKey, entry);
        const replacement =
          change === "logical source"
            ? openOpenClawAgentDatabase({ agentId: "main", env, path: path("family.sqlite") })
            : undefined;
        if (replacement) {
          writeSessionEntry(replacement, sessionKey, { ...entry, label: "replacement" });
          // Ambiguous unsuffixed registration initially selects the main-owned suffix.
          registerOpenClawAgentDatabase({ agentId: "ops", path: replacement.path, env });
        }
        expect(await entryReads.readSessionEntryReadOnlyInWorker(scope)).toMatchObject(entry);
        const writerReady = createDeferred();
        const releaseWriter = createDeferred();
        const firstRead = createDeferred();
        const admissionOutcome = createDeferred<{ accepted: boolean; error?: unknown }>();
        const beginAdmission = sessionLifecycle.beginSessionWorkAdmission;
        const reader = vi
          .spyOn(sessionLifecycle, "beginSessionWorkAdmission")
          .mockImplementation((params) => {
            const admission = beginAdmission({
              ...params,
              assertAllowed: async (admissionSignal) => {
                await params.assertAllowed(admissionSignal);
                firstRead.resolve();
              },
            });
            void admission.then(
              () => admissionOutcome.resolve({ accepted: true }),
              (error: unknown) => admissionOutcome.resolve({ accepted: false, error }),
            );
            return admission;
          });
        const writer = runExclusiveSessionStoreWrite(storePath, async () => {
          writerReady.resolve();
          await releaseWriter.promise;
        });
        const peer = new (requireNodeSqlite().DatabaseSync)(database.path);
        await writerReady.promise;
        let sql: ReturnType<typeof observeHostDataSql> | undefined;
        try {
          const followupRun = createTestFollowupRun({
            sessionKey,
            sessionId: "maintenance-worker",
          });
          withPluginRuntimeGatewayRequestScope(
            { pluginRegistry: createEmptyPluginRegistry(), isWebchatConnect: () => false },
            () =>
              scheduleSessionMaintenance({
                prepared: { cfg: {}, sessionKey, storePath, timeoutMs: 60_000 },
                followupRun,
                sessionId: "maintenance-worker",
                lifecycleRevision: "initial",
                lifecycleGeneration: getAgentEventLifecycleGeneration(),
                startedAt: Date.now(),
              }),
          );
          await withinTest(firstRead.promise, signal);
          if (replacement) {
            writeSessionEntry(database, sessionKey, {
              ...entry,
              pendingFinalDelivery: {
                kind: "replayable",
                createdAt: 1,
                text: "pending final",
                intentId: "pending-final",
              },
            });
            unregisterOpenClawAgentDatabase({ agentId: "ops", path: replacement.path, env });
            expect(await entryReads.readSessionEntryReadOnlyInWorker(scope)).toMatchObject({
              ...entry,
              label: "replacement",
            });
            expect(readDatabasePathIdentitySync(database.path)).toEqual(originalIdentity);
            expect(
              await entryReads.readSessionEntryReadOnlyInWorker({
                ...scope,
                storePath: database.path,
              }),
            ).toMatchObject({ pendingFinalDelivery: { intentId: "pending-final" } });
          } else {
            peer
              .prepare(
                "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.lifecycleRevision', 'replacement') WHERE session_key = ?",
              )
              .run(sessionKey);
            peer
              .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
              .run(sessionKey);
          }
          sql = observeHostDataSql();
          releaseWriter.resolve();
          await writer;
          await waitForSessionMaintenance(sessionKey);
          expect(await admissionOutcome.promise).toMatchObject({
            accepted: false,
            error: { name: "AbortError" },
          });
          expect(memory.runMemoryFlushIfNeeded).not.toHaveBeenCalled();
          expect(memory.runSessionCompactionIfNeeded).not.toHaveBeenCalled();
          expect(
            sql.queries.filter((query) =>
              /\bsession_(?:nodes|participants)\b|PRAGMA\s+query_only/i.test(query),
            ),
          ).toEqual([]);
        } finally {
          releaseWriter.resolve();
          await writer;
          await waitForSessionMaintenance(sessionKey);
          sql?.restore();
          reader.mockRestore();
          peer.close();
        }
      },
    );
  },
);
