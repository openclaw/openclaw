import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../../src/config/runtime-snapshot.js";
import { importSqliteSessionRows } from "../../../../src/config/sessions/session-accessor.sqlite-import.test-support.js";
import { loadTranscriptEventsSync } from "../../../../src/config/sessions/session-accessor.sqlite-read.js";
import { replaceTranscriptEvents } from "../../../../src/config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
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
  RegisteredMemorySearchManager as MemoryManager,
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
  let initial: Awaited<ReturnType<typeof acquireManager>>;
  const managers = new Set<MemoryManager>();
  const sessionId = "memory-revision";
  const sessionKey = `agent:main:chat:${sessionId}`;
  const memoryPath = `sessions/main/${sessionId}.jsonl`;
  const fts = "memory_index_chunks_fts";
  const query = (table: string, columns = "*") =>
    observer.prepare(`SELECT ${columns} FROM ${table} WHERE path = ?`);
  const scope = () => ({
    agentId: "main",
    sessionId,
    sessionKey,
    storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
  });
  const events = (color: string) => [
    {
      type: "message",
      id: "preference",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: `My ${color} preference is documented here.` },
    },
  ];
  const published = () => ({
    source: query("memory_index_sources").all(memoryPath),
    chunks: query("memory_index_chunks").all(memoryPath),
    fts: query(fts).all(memoryPath),
  });
  const matches = (word: string) =>
    observer
      .prepare(`SELECT text FROM ${fts} WHERE ${fts} MATCH ? AND path = ?`)
      .all(word, memoryPath);

  async function expectRecall(manager: MemoryManager, color: string, absent?: string) {
    expect(matches(color)).toEqual([{ text: `User: My ${color} preference is documented here.` }]);
    if (absent) {
      expect(matches(absent)).toEqual([]);
    }
    expect((await manager.search(color)).map((hit) => hit.path)).toContain(memoryPath);
  }

  async function acquireManager(inspectSources = false) {
    const { manager, error } = await getMemorySearchManager({
      cfg,
      agentId: "main",
      purpose: "cli",
      inspectSources,
    });
    assert(manager?.sync, error ?? "Expected a synchronizable memory manager");
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
    setRuntimeConfigSnapshot(cfg);
    await importSqliteSessionRows({
      ...scope(),
      entry: { sessionId, updatedAt: 1 },
      transcriptMtimeMs: 1,
      readTranscriptEvents: (append) => events("violet").forEach(append),
    });
    observer = new DatabaseSync(scope().storePath, { readOnly: true });
    initial = await acquireManager();
    await initial.sync({ force: true });
    expect(matches("violet")).toHaveLength(1);
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
      if (legacy) {
        const entry = await buildSessionEntry(sessionKey, {
          ...scope(),
          updatedAtMs: 1,
          sessionKind: "interactive",
        });
        assert(entry, "Expected the previously indexed session export");
        runOpenClawAgentWriteTransaction(
          ({ db }) => {
            db.prepare(
              "UPDATE memory_index_sources SET hash = ? WHERE path = ? AND source = 'sessions'",
            ).run(entry.hash, memoryPath);
          },
          { agentId: "main", path: scope().storePath },
        );
      }
      await initial.manager.close?.();

      await replaceTranscriptEvents(scope(), events("orange"));
      await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: scope().storePath });

      const restarted = await acquireManager(true);
      await restarted.sync({ reason: "cli" });
      await expectRecall(restarted.manager, "orange", "violet");
      expect(restarted.manager.status().dirty).toBe(false);
      expect(query("memory_index_sources", "mtime").get(memoryPath)).toEqual({ mtime: 1 });
      await restarted.manager.close?.();
      expect((await acquireManager(true)).manager.status().dirty).toBe(false);
    },
  );

  it("preserves published recall across a damaged cold rebuild and recovery", async () => {
    const { manager, sync } = initial;
    const before = published();
    const canonical = loadTranscriptEventsSync(scope());
    await runSessionColdStorageMaintenance({ config: cfg });
    const cold = readSessionColdTranscript(observer, sessionId);
    assert(cold, "Expected an archived canonical transcript");
    expect(() => loadTranscriptEventsSync(scope())).toThrow(/cold storage/);
    const archivePath = resolveSessionColdArchivePath(scope().storePath, cold.archive_name);
    const archive = await fs.readFile(archivePath);
    await fs.writeFile(archivePath, "damaged archive");
    await expect(sync({ force: true })).rejects.toThrow();
    expect(published()).toEqual(before);
    expect(manager.status().dirty).toBe(true);
    expect(manager.status().lastSyncError).toBeTruthy();
    await fs.writeFile(archivePath, archive);

    // Automatic rebuilds retry after the documented 30-second failure cooldown.
    {
      using _ = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30_000);
      await sync();
    }
    await expectRecall(manager, "violet");
    expect(loadTranscriptEventsSync(scope())).toEqual(canonical);
    expect(readSessionColdTranscript(observer, sessionId)).toBeUndefined();
    expect(manager.status()).toMatchObject({ dirty: false, lastSyncError: undefined });
  });
});
