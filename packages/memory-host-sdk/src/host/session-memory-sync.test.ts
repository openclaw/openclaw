import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importSqliteSessionRows } from "../../../../src/config/sessions/session-accessor.sqlite-import.test-support.js";
import {
  loadTranscriptEventsSync,
  readTranscriptStatsSync,
} from "../../../../src/config/sessions/session-accessor.sqlite-read.js";
import { replaceTranscriptEvents } from "../../../../src/config/sessions/session-accessor.sqlite-transcript-write.js";
import { resolveSessionColdArchivePath } from "../../../../src/config/sessions/session-cold-storage-codec.js";
import { readSessionColdTranscript } from "../../../../src/config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "../../../../src/config/sessions/session-cold-storage.js";
import { waitForSessionTranscriptIndexReconcile } from "../../../../src/config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "../../../../src/plugin-sdk/plugin-state-runtime.js";
import { createPluginStateKeyedStoreForTests } from "../../../../src/plugin-sdk/plugin-state-test-runtime.js";
import type {
  MemoryPluginRuntime,
  RegisteredMemorySearchManager,
} from "../../../../src/plugins/registry-contribution-types.js";
import { runOpenClawAgentWriteTransaction } from "../../../../src/state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../../../src/state/openclaw-agent-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../../src/test-utils/openclaw-test-state.js";
import { buildSessionEntry } from "./session-files.js";

const { configureMemoryCoreDreamingState, getMemorySearchManager } = await vi.importActual<
  Pick<MemoryPluginRuntime, "getMemorySearchManager"> & {
    configureMemoryCoreDreamingState: (
      open: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
    ) => void;
  }
>("../../../../extensions/memory-core/runtime-api.js");

describe("memory synchronization of canonical SQLite transcripts", () => {
  let state: OpenClawTestState;
  let cfg: OpenClawConfig;
  let observer: DatabaseSync;
  const managers = new Set<RegisteredMemorySearchManager>();
  const sessionId = "memory-revision";
  const sessionKey = `agent:main:chat:${sessionId}`;
  const memoryPath = `sessions/main/${sessionId}.jsonl`;
  const scope = () => ({
    agentId: "main",
    sessionId,
    sessionKey,
    storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
  });
  const events = (color: string) => [
    { type: "session", id: sessionId, version: 3 },
    {
      type: "message",
      id: "preference",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: `My ${color} preference is documented here.` },
    },
  ];
  const published = () => ({
    source: observer.prepare("SELECT * FROM memory_index_sources WHERE path = ?").all(memoryPath),
    chunks: observer.prepare("SELECT * FROM memory_index_chunks WHERE path = ?").all(memoryPath),
    fts: observer.prepare("SELECT * FROM memory_index_chunks_fts WHERE path = ?").all(memoryPath),
  });
  const matches = (word: string) =>
    observer
      .prepare(
        "SELECT text FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ? AND path = ?",
      )
      .all(word, memoryPath);

  async function acquireManager(inspectSources = false) {
    const { manager, error } = await getMemorySearchManager({
      cfg,
      agentId: "main",
      purpose: "cli",
      inspectSources,
    });
    if (!manager?.sync) {
      throw new Error(error ?? "Expected a synchronizable memory manager");
    }
    managers.add(manager);
    return { manager, sync: manager.sync.bind(manager) };
  }

  beforeEach(async () => {
    state = await createOpenClawTestState({
      prefix: "memory-transcript-sync-",
      layout: "state-only",
    });
    const env = { ...state.env };
    configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) =>
      createPluginStateKeyedStoreForTests<T>("memory-core", { ...options, env }),
    );
    cfg = {
      plugins: { enabled: false },
      agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
      memory: {
        search: {
          provider: "none",
          sources: ["sessions"],
          rememberAcrossConversations: true,
          store: { vector: { enabled: false } },
          query: { minScore: 0 },
        },
      },
      session: {
        store: scope().storePath,
        maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
      },
    };
    await state.writeConfig(cfg);
    await importSqliteSessionRows({
      ...scope(),
      entry: { sessionId, updatedAt: 1 },
      transcriptMtimeMs: 1,
      readTranscriptEvents: (append) => {
        for (const event of events("violet")) {
          append(event);
        }
      },
    });
    observer = new DatabaseSync(scope().storePath, { readOnly: true });
  });

  afterEach(async () => {
    for (const manager of managers) {
      await manager.close?.();
    }
    managers.clear();
    observer?.close();
    await state?.cleanup();
    configureMemoryCoreDreamingState(() => {
      throw new Error("memory test state is closed");
    });
  });

  it.each([false, true])(
    "replaces stale recall after a closed-manager equal-size rewrite (legacy hash: %s)",
    async (legacy) => {
      const original = await acquireManager();
      await original.sync({ force: true });
      expect(matches("violet")).toHaveLength(1);
      if (legacy) {
        const entry = await buildSessionEntry(sessionKey, {
          ...scope(),
          updatedAtMs: 1,
          sessionKind: "interactive",
        });
        if (!entry) {
          throw new Error("Expected the previously indexed session export");
        }
        runOpenClawAgentWriteTransaction(
          ({ db }) => {
            db.prepare(
              "UPDATE memory_index_sources SET hash = ? WHERE path = ? AND source = 'sessions'",
            ).run(entry.hash, memoryPath);
          },
          { agentId: "main", path: scope().storePath },
        );
      }
      const beforeStats = readTranscriptStatsSync(scope());
      await original.manager.close?.();

      await replaceTranscriptEvents(scope(), events("orange"));
      await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: scope().storePath });
      const afterStats = readTranscriptStatsSync(scope());
      expect(afterStats).toMatchObject({
        sizeBytes: beforeStats.sizeBytes,
        eventCount: beforeStats.eventCount,
        maxSeq: beforeStats.maxSeq,
      });
      expect(afterStats.lastMutationAtMs).toBeGreaterThan(beforeStats.lastMutationAtMs ?? 0);

      const restarted = await acquireManager(true);
      await restarted.sync({ reason: "cli" });
      expect(matches("orange")).toEqual([
        { text: "User: My orange preference is documented here." },
      ]);
      expect(matches("violet")).toEqual([]);
      expect((await restarted.manager.search("orange")).map((hit) => hit.path)).toContain(
        memoryPath,
      );
      expect(restarted.manager.status().dirty).toBe(false);
      expect(
        observer.prepare("SELECT mtime FROM memory_index_sources WHERE path = ?").get(memoryPath),
      ).toEqual({ mtime: 1 });
      await restarted.manager.close?.();
      expect((await acquireManager(true)).manager.status().dirty).toBe(false);
    },
  );

  it.each([false, true])(
    "preserves published recall across a cold rebuild (damaged archive: %s)",
    async (damaged) => {
      const { manager, sync } = await acquireManager();
      await sync({ force: true });
      const before = published();
      expect(matches("violet")).toHaveLength(1);
      const canonical = loadTranscriptEventsSync(scope());
      expect(await runSessionColdStorageMaintenance({ config: cfg })).toEqual({
        archivedTranscripts: 1,
        externalizedTranscripts: 0,
      });
      const cold = readSessionColdTranscript(observer, sessionId);
      if (!cold) {
        throw new Error("Expected an archived canonical transcript");
      }
      expect(() => loadTranscriptEventsSync(scope())).toThrow(/cold storage/);
      const archivePath = resolveSessionColdArchivePath(scope().storePath, cold.archive_name);
      const archive = await fs.readFile(archivePath);
      if (damaged) {
        await fs.writeFile(archivePath, "damaged archive");
        await expect(sync({ force: true })).rejects.toThrow();
        expect(published()).toEqual(before);
        expect(manager.status().dirty).toBe(true);
        expect(manager.status().lastSyncError).toBeTruthy();
        await fs.writeFile(archivePath, archive);
      }

      await sync(damaged ? undefined : { force: true });
      expect(matches("violet")).toEqual([
        { text: "User: My violet preference is documented here." },
      ]);
      expect((await manager.search("violet")).map((hit) => hit.path)).toContain(memoryPath);
      expect(loadTranscriptEventsSync(scope())).toEqual(canonical);
      expect(readSessionColdTranscript(observer, sessionId)).toBeUndefined();
      expect(manager.status().dirty).toBe(false);
      expect(manager.status().lastSyncError).toBeUndefined();
    },
  );
});
