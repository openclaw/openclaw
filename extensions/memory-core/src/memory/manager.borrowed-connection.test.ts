import { unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  listSessionTranscriptCorpusEntriesForAgent,
  sessionPathForFile,
  sessionPathForSessionIdentity,
} from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  encodeMemoryEmbedding,
  ensureMemoryChunkProvenance,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { deleteSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { withSessionTranscriptWriteLock } from "openclaw/plugin-sdk/session-transcript-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedMemoryForgetTombstones } from "../test-helpers.js";
import { runInMemoryTestBackgroundContext } from "./background-context.test-support.js";
import { memoryCpuProcessEntrypoints } from "./manager-cpu-entrypoints.js";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import { MemoryIndexRevisionConflictError } from "./manager-db-kernel.js";
import {
  createManagerIndexFixture,
  readPublishedSessionIndex,
} from "./manager-index.test-support.js";
import { memoryPublicationFaultEntrypoint } from "./manager-publication-fault-entrypoint.test-support.js";
import { MemoryIndexManager } from "./manager.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

function managerDatabase(manager: MemoryIndexManager): DatabaseSync {
  return (manager as unknown as { db: DatabaseSync }).db;
}

describe("memory manager agent database lifecycle", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const createConfig = () => fixture.createConfig({ provider: "none", vectorEnabled: false });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("isolates manager readers across settings replacement and keeps the shared writer alive", async () => {
    const shared = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" });
    const first = await fixture.getFreshManager(createConfig());
    const firstDb = managerDatabase(first);
    expect(firstDb.location()).toBe(shared.path);
    expect(() => firstDb.exec("DELETE FROM memory_index_chunks")).toThrow(/readonly/i);
    const replacement = await fixture.getFreshManager(
      fixture.createConfig({
        provider: "none",
        vectorEnabled: false,
        minScore: 0.1,
      }),
    );

    expect(replacement === first).toBe(false);
    expect(managerDatabase(replacement).location()).toBe(shared.path);
    await first.close();
    expect(firstDb.isOpen).toBe(false);
    expect(managerDatabase(replacement).isOpen).toBe(true);
    await replacement.sync({ reason: "test", force: true });
    expect((await replacement.search("Alpha")).length).toBeGreaterThan(0);
    await closeAllMemorySearchManagers();
    expect(shared.db.isOpen).toBe(true);
    expect(shared.db.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks").get()).toEqual({
      count: 1,
    });
  });

  it("rejects shared integrity failure before exposing a manager", async () => {
    const shared = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" });
    closeOpenClawAgentDatabasesForTest();
    const damaged = new DatabaseSync(shared.path);
    try {
      damaged.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE fixture_parent (id INTEGER PRIMARY KEY);
        CREATE TABLE fixture_child (parent_id INTEGER REFERENCES fixture_parent(id));
        INSERT INTO fixture_child VALUES (1);
      `);
    } finally {
      damaged.close();
    }
    // Replaced files cannot reuse the original connection's clean integrity receipt.
    const replacementPath = `${shared.path}.replacement`;
    await fs.copyFile(shared.path, replacementPath);
    await fs.rename(replacementPath, shared.path);

    expect(() => sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" })).toThrow(
      /foreign_key_check/,
    );
    const result = await getMemorySearchManager({
      runInBackgroundContext: runInMemoryTestBackgroundContext,
      cfg: createConfig(),
      agentId: "main",
    });
    expect(result.manager).toBeNull();
    expect(result.error).toMatch(/foreign_key_check/);
  });

  it("resumes vector writes after another manager publishes an empty rebuild", async () => {
    const cfg = fixture.createConfig({ provider: "openai", vectorEnabled: true });
    const manager = await fixture.getFreshManager(cfg, "cli");
    const memoryFile = path.join(fixture.paths.memory, "2026-01-12.md");
    await manager.sync({ reason: "cli", force: true });
    const db = managerDatabase(manager);
    const vectorTexts = () =>
      db
        .prepare(
          "SELECT c.text FROM memory_index_chunks c JOIN memory_index_chunks_vec v ON v.id = c.id ORDER BY c.text",
        )
        .all();

    for (const text of ["Alpha first replacement.", "Beta second replacement."]) {
      await fs.writeFile(memoryFile, text);
      await manager.sync({ reason: "search-bootstrap" });
      expect(vectorTexts()).toEqual([{ text }]);
    }

    const maintenance = await MemoryIndexManager.get({
      cfg,
      agentId: "main",
      purpose: "maintenance",
      maintenanceSource: manager,
    });
    if (!maintenance) {
      throw new Error("maintenance manager missing");
    }
    fixture.trackManager(maintenance);
    await fs.unlink(memoryFile);
    await maintenance.sync({ reason: "cli", force: true });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_index_chunks_vec'").get(),
    ).toBeUndefined();

    await fs.writeFile(memoryFile, "Alpha after empty rebuild.");
    await manager.sync({ reason: "search-bootstrap" });
    expect(vectorTexts()).toEqual([{ text: "Alpha after empty rebuild." }]);
  });

  it("replaces a revoked shared handle without an old release closing its replacement", async () => {
    const first = await fixture.getFreshManager(createConfig());
    const originalDb = managerDatabase(first);
    closeOpenClawAgentDatabasesForTest();
    expect(originalDb.isOpen).toBe(false);
    await closeOpenClawAgentDatabasesAsync();
    const replacement = await fixture.getFreshManager(createConfig());
    expect(replacement === first).toBe(false);
    const shared = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" });
    expect(managerDatabase(replacement).location()).toBe(shared.path);
    await first.close();
    await replacement.sync({ reason: "test", force: true });
    expect((await replacement.search("Alpha")).length).toBeGreaterThan(0);
  });

  it("rejects queued maintenance without reopening its retired source connection", async () => {
    const cfg = createConfig();
    const source = await fixture.getFreshManager(cfg, "cli");
    const sourcePath = source.status().dbPath;
    const target = {
      agentId: "main",
      sessionKey: "agent:main:maintenance-admission",
      sessionId: "maintenance-admission",
    };
    await upsertSessionEntry({
      ...target,
      entry: { sessionId: target.sessionId, updatedAt: Date.now() },
    });
    const entered = createDeferred<void>();
    const released = createDeferred<void>();
    const queued = createDeferred<void>();
    const writer = withSessionTranscriptWriteLock(target, async () => {
      entered.resolve();
      await released.promise;
      closeOpenClawAgentDatabasesForTest();
    });
    await entered.promise;
    const open = sqliteRuntime.openOpenClawAgentSqliteWorkerStoreV2;
    vi.spyOn(sqliteRuntime, "openOpenClawAgentSqliteWorkerStoreV2").mockImplementation(
      async (...args) => {
        const store = await open(...args);
        const prepare = store.prepare.bind(store);
        vi.spyOn(store, "prepare").mockImplementation((...prepareArgs) => {
          const result = prepare(...prepareArgs);
          queued.resolve();
          return result;
        });
        return store;
      },
    );
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const creating = MemoryIndexManager.get({
      runInBackgroundContext: runInMemoryTestBackgroundContext,
      cfg,
      agentId: "main",
      purpose: "maintenance",
      maintenanceSource: source,
    });
    void creating.catch(() => undefined);
    try {
      await Promise.race([queued.promise, creating]);
      released.resolve();
      await expect(creating).rejects.toThrow(/^Agent database execution admission is closed$/);
      expect(
        prepare.mock.contexts.filter(
          (database) =>
            database instanceof DatabaseSync &&
            database.isOpen &&
            database.location() === sourcePath,
        ),
      ).toEqual([]);
    } finally {
      released.resolve();
      await Promise.allSettled([writer, creating]);
    }
  });

  it("serves published hits while dirty maintenance setup meets a separate writer lock", async () => {
    const manager = await fixture.getFreshManager(createConfig());
    await manager.sync({ reason: "baseline", force: true });
    const shared = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" });
    const writer = new DatabaseSync(shared.path);
    writer.exec("BEGIN IMMEDIATE");
    try {
      Reflect.set(manager, "dirty", true);
      const started = performance.now();
      const results = await manager.search("Alpha");
      expect(results.some((result) => result.path === "memory/2026-01-12.md")).toBe(true);
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
      await manager.close();
    }
  });

  it("preserves a newer source when archive cleanup waits for write admission", async () => {
    const sessionId = "archive-publication-race";
    await fixture.seedSessionTranscript({
      sessionId,
      messages: [{ role: "user", timestamp: Date.now(), content: "Violet archived memory." }],
    });
    const manager = await fixture.getFreshManager(
      fixture.createConfig({ provider: "none", sources: ["sessions"], sessionMemory: true }),
      "cli",
    );
    await manager.sync({ reason: "baseline", force: true });
    await deleteSessionEntry({
      agentId: "main",
      sessionKey: `agent:main:memory:${sessionId}`,
      expectedSessionId: sessionId,
      archiveTranscript: true,
    });
    const archive = (await listSessionTranscriptCorpusEntriesForAgent("main")).find(
      (entry) => entry.sessionId === sessionId,
    );
    expect(archive?.artifactKind).toBe("archive-artifact");
    const shared = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" });
    const writer = new DatabaseSync(shared.path);
    const livePath = sessionPathForSessionIdentity("main", sessionId);
    let releaseWriter: NodeJS.Timeout | undefined;
    try {
      await manager.sync({
        reason: "archive-cleanup",
        archiveFiles: [archive!.sessionFile],
        progress: ({ completed, total }) => {
          if (total > 0 && completed === total && !releaseWriter) {
            writer.exec("BEGIN IMMEDIATE");
            writer
              .prepare(
                "UPDATE memory_index_sources SET hash = 'newer-publication' WHERE source = 'sessions' AND path = ?",
              )
              .run(livePath);
            releaseWriter = setTimeout(() => writer.exec("COMMIT"), 100);
          }
        },
      });
      expect(releaseWriter).toBeDefined();
      expect(
        shared.db
          .prepare("SELECT hash FROM memory_index_sources WHERE source = 'sessions' AND path = ?")
          .get(livePath),
      ).toEqual({ hash: "newer-publication" });
    } finally {
      clearTimeout(releaseWriter);
      if (writer.isTransaction) {
        writer.exec("ROLLBACK");
      }
      writer.close();
      await manager.close();
    }
  });

  it("rebuilds a session snapshot after metadata refresh loses to schema invalidation", async () => {
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    const transcript = path.join(
      sessionsDir,
      "metadata-race.jsonl.deleted.2026-09-01T00-00-00.000Z",
    );
    await fs.mkdir(sessionsDir, { recursive: true });
    const writeTranscript = (content: string) =>
      fs.writeFile(
        transcript,
        `${JSON.stringify({ type: "message", message: { role: "user", content } })}\n`,
      );
    await writeTranscript("Old violet history.");
    const manager = await fixture.getFreshManager(
      fixture.createConfig({ provider: "none", sources: ["sessions"], sessionMemory: true }),
      "cli",
    );
    await manager.sync({ reason: "baseline", force: true });
    const shared = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" });
    const sourcePath = sessionPathForFile(transcript);
    const readSource = shared.db.prepare(
      "SELECT hash FROM memory_index_sources WHERE path = ? AND source = 'sessions'",
    );
    expect(readSource.get(sourcePath)).toBeDefined();
    // Legacy/imported chunks can await a later constructor's provenance reconciliation.
    shared.db
      .prepare(
        "DELETE FROM memory_index_chunk_provenance WHERE chunk_id IN (SELECT id FROM memory_index_chunks WHERE path = ? AND source = 'sessions')",
      )
      .run(sourcePath);
    Reflect.set(manager, "sessionsDirty", true);
    Reflect.set(manager, "sessionsDirtyFiles", new Set([transcript]));
    const writer = new DatabaseSync(shared.path);
    const refreshPrepared = createDeferred<void>();
    const releaseRefresh = createDeferred<void>();
    // oxlint-disable-next-line typescript/unbound-method -- Called with the captured database owner.
    const refreshSourceState = MemoryIndexDatabase.prototype.refreshSourceState;
    const observeRefresh = vi
      .spyOn(MemoryIndexDatabase.prototype, "refreshSourceState")
      .mockImplementationOnce(async function (this: MemoryIndexDatabase, input, assertCurrent) {
        refreshPrepared.resolve();
        await releaseRefresh.promise;
        return refreshSourceState.call(this, input, assertCurrent);
      });
    const sync = manager.sync({ reason: "session-delta" });
    void sync.catch(() => undefined);
    try {
      await Promise.race([
        refreshPrepared.promise,
        sync.then(() => {
          throw new Error("Session sync settled before preparing the fingerprint refresh");
        }),
      ]);
      writer.exec("BEGIN IMMEDIATE");
      ensureMemoryChunkProvenance(writer);
      await writeTranscript("Newest violet history.");
      writer.exec("COMMIT");
      releaseRefresh.resolve();
      const outcome = await sync.then(
        () => null,
        (error: unknown) => error,
      );
      expect(readSource.get(sourcePath)).toEqual({ hash: "" });
      expect(outcome).toBeInstanceOf(MemoryIndexRevisionConflictError);
      expect(manager.status().dirty).toBe(true);
      await manager.sync({ reason: "retry-metadata" });
      const indexed = shared.db
        .prepare("SELECT text FROM memory_index_chunks WHERE path = ? AND source = 'sessions'")
        .all(sourcePath)
        .map((row) => row.text)
        .join("\n");
      expect(indexed).toContain("Newest violet history.");
      expect(indexed).not.toContain("Old violet history.");
      expect(manager.status().dirty).toBe(false);
    } finally {
      releaseRefresh.resolve();
      observeRefresh.mockRestore();
      if (writer.isTransaction) {
        writer.exec("ROLLBACK");
      }
      writer.close();
      await sync.catch(() => undefined);
      await manager.close();
    }
  });

  it.each([false, true])(
    "preserves a newer publication during rejected media cleanup (previously indexed: %s)",
    async (previouslyIndexed) => {
      const mediaDir = path.join(fixture.paths.workspace, "media-memory");
      const imagePath = path.join(mediaDir, "diagram.png");
      const sourcePath = "media-memory/diagram.png";
      await fs.mkdir(mediaDir, { recursive: true });
      if (previouslyIndexed) {
        await fs.writeFile(imagePath, Buffer.from("png"));
      }
      const manager = await fixture.getFreshManager(
        fixture.createConfig({
          provider: "gemini",
          model: "gemini-embedding-2-preview",
          vectorEnabled: false,
          extraPaths: [mediaDir],
          multimodal: { enabled: true, modalities: ["image"], maxFileBytes: 128 },
        }),
        "cli",
      );
      await manager.sync({ reason: "baseline", force: true });
      await fs.writeFile(imagePath, Buffer.from("changed png"));
      Reflect.set(manager, "dirty", true);
      const shared = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" });
      const readSource = shared.db.prepare(
        "SELECT hash FROM memory_index_sources WHERE path = ? AND source = 'memory'",
      );
      const indexedSource = readSource.get(sourcePath);
      expect(indexedSource !== undefined).toBe(previouslyIndexed);
      const writer = new DatabaseSync(shared.path);
      let publicationStarted = false;
      let deletionCount = 0;
      // oxlint-disable-next-line typescript/unbound-method -- Called with the actual database owner.
      const deleteSource = MemoryIndexDatabase.prototype.deleteSource;
      const publicationSpy = vi
        .spyOn(MemoryIndexDatabase.prototype, "deleteSource")
        .mockImplementation(function (this: MemoryIndexDatabase, input, assertCurrent) {
          if (input.path === sourcePath && input.source === "memory") {
            deletionCount += 1;
            expect(input.expectedHash).toBe(indexedSource?.hash);
            expect(writer.isTransaction).toBe(true);
            writer.exec("COMMIT");
          }
          return deleteSource.call(this, input, assertCurrent);
        });
      try {
        await manager.sync({
          reason: "watch",
          progress: ({ label }) => {
            if (label?.startsWith("Indexing memory files") && !publicationStarted) {
              unlinkSync(imagePath);
              writer.exec("BEGIN IMMEDIATE");
              writer
                .prepare(
                  "INSERT INTO memory_index_sources(path, source, hash, mtime, size) VALUES (?, 'memory', 'newer-media-publication', 1, 1) ON CONFLICT(path, source) DO UPDATE SET hash = excluded.hash",
                )
                .run(sourcePath);
              publicationStarted = true;
            }
          },
        });
        expect(publicationStarted).toBe(true);
        expect(deletionCount).toBe(1);
        expect(readSource.get(sourcePath)).toEqual({ hash: "newer-media-publication" });
      } finally {
        try {
          if (writer.isTransaction) {
            writer.exec("ROLLBACK");
          }
          writer.close();
          await manager.close();
        } finally {
          publicationSpy.mockRestore();
        }
      }
    },
  );

  it.each([
    "watched-file",
    "deleted-memory",
    "deleted-session",
    "session-fingerprint",
    "cache-prune",
  ])("keeps searches and timers responsive during contended %s maintenance", async (scenario) => {
    const sessionWork = scenario === "deleted-session" || scenario === "session-fingerprint";
    const sessionId = "maintenance-session";
    if (sessionWork) {
      await fixture.seedSessionTranscript({
        sessionId,
        messages: [{ role: "user", timestamp: Date.now(), content: "Violet session content." }],
      });
    }
    const cfg = fixture.createConfig({
      provider: "none",
      vectorEnabled: false,
      sources: sessionWork ? ["memory", "sessions"] : ["memory"],
      sessionMemory: sessionWork,
    });
    const manager = await fixture.getFreshManager(cfg, "cli");
    const changedPath = path.join(fixture.paths.memory, "updated.md");
    await fs.writeFile(changedPath, "Updated violet memory.");
    await manager.sync({ reason: "baseline", force: true });
    const reader = await fixture.getFreshManager(cfg, "cli");
    await reader.search("Alpha");
    const shared = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" });
    if (scenario === "deleted-memory") {
      await fs.unlink(changedPath);
      shared.db
        .prepare(
          "INSERT INTO memory_index_chunks(id, path, source, model, start_line, end_line, hash, text, embedding, updated_at) VALUES ('old-model', 'memory/updated.md', 'memory', 'old-model', 1, 1, 'old-hash', 'old-model violet', x'', 1)",
        )
        .run();
      shared.db
        .prepare(
          "INSERT INTO memory_index_chunks(id, path, source, model, start_line, end_line, hash, text, embedding, updated_at) VALUES ('other-source', 'memory/updated.md', 'sessions', 'old-model', 1, 1, 'other-hash', 'other-source', x'', 1)",
        )
        .run();
    } else if (scenario === "watched-file") {
      await fs.writeFile(changedPath, "Refreshed violet memory.");
    }
    if (scenario === "cache-prune") {
      const owner = manager as unknown as { cache: { maxEntries: number } };
      owner.cache.maxEntries = 2;
      const insert = shared.db.prepare(
        "INSERT INTO memory_embedding_cache(provider, model, provider_key, hash, embedding, dims, updated_at) VALUES ('fixture', 'fixture', 'fixture', ?, ?, 1, ?)",
      );
      for (let index = 0; index < 331; index += 1) {
        insert.run(`cache-${index}`, encodeMemoryEmbedding([1]), index);
      }
    }
    if (sessionWork) {
      const session = (await listSessionTranscriptCorpusEntriesForAgent("main")).find(
        (entry) => entry.sessionId === sessionId,
      );
      expect(session).toBeDefined();
      Reflect.set(manager, "sessionsDirty", true);
      if (scenario === "deleted-session") {
        seedMemoryForgetTombstones({ agentId: "main", sessionIds: [sessionId] });
        Reflect.set(manager, "sessionsReconcileDirty", true);
      } else {
        shared.db
          .prepare("UPDATE memory_index_sources SET mtime = 0, size = 0 WHERE source = 'sessions'")
          .run();
        Reflect.set(manager, "sessionsDirtyFiles", new Set([session!.sessionFile]));
      }
    } else if (scenario !== "cache-prune") {
      Reflect.set(manager, "dirty", true);
    }
    const writer = new DatabaseSync(shared.path);
    writer.exec("BEGIN IMMEDIATE");
    const started = performance.now();
    const writerReleased = createDeferred<void>();
    const observedCacheCounts = new Set<number>();
    let observeCacheTimer: NodeJS.Immediate | undefined;
    const observeCache = () => {
      observedCacheCounts.add(
        Number(
          shared.db.prepare("SELECT COUNT(*) AS count FROM memory_embedding_cache").get()?.count,
        ),
      );
      observeCacheTimer = setImmediate(observeCache);
    };
    const releaseWriter = setTimeout(() => {
      writer.exec("ROLLBACK");
      if (scenario === "cache-prune") {
        observeCache();
      }
      writerReleased.resolve();
    }, 100);
    const sync = manager.sync({ reason: sessionWork ? "session-delta" : "watch" });
    void sync.catch(() => undefined);
    try {
      const [results] = await Promise.all([reader.search("Alpha"), writerReleased.promise]);
      expect(results.some((result) => result.path === "memory/2026-01-12.md")).toBe(true);
      expect(performance.now() - started).toBeLessThan(1000);
      await sync;
      if (scenario === "deleted-memory") {
        expect(
          shared.db
            .prepare(
              "SELECT model FROM memory_index_chunks_fts WHERE path = 'memory/updated.md' ORDER BY source",
            )
            .all(),
        ).toEqual([{ model: "old-model" }]);
        expect(
          (await reader.search("violet", { sources: ["memory"] })).some(
            (result) => result.path === "memory/updated.md",
          ),
        ).toBe(false);
      } else if (scenario === "deleted-session") {
        expect(
          shared.db
            .prepare("SELECT path FROM memory_index_sources WHERE source = 'sessions'")
            .all(),
        ).toEqual([]);
        expect(
          shared.db.prepare("SELECT text FROM memory_index_chunks WHERE source = 'sessions'").all(),
        ).toEqual([]);
      } else if (scenario === "session-fingerprint") {
        expect(
          shared.db
            .prepare(
              "SELECT mtime > 0 AS refreshed FROM memory_index_sources WHERE source = 'sessions'",
            )
            .get(),
        ).toEqual({ refreshed: 1 });
      } else if (scenario === "cache-prune") {
        expect(
          shared.db.prepare("SELECT hash FROM memory_embedding_cache ORDER BY updated_at").all(),
        ).toEqual([{ hash: "cache-329" }, { hash: "cache-330" }]);
        expect([...observedCacheCounts].some((count) => count > 2 && count < 331)).toBe(true);
      } else {
        expect(
          (await reader.search("violet")).some((result) => result.snippet.includes("Refreshed")),
        ).toBe(true);
      }
    } finally {
      clearTimeout(releaseWriter);
      clearImmediate(observeCacheTimer);
      if (writer.isTransaction) {
        writer.exec("ROLLBACK");
      }
      writer.close();
      await sync.catch(() => undefined);
      await manager.close();
    }
  });

  it("does not replay a committed prune batch after its native reply fails", async () => {
    const cfg = fixture.createConfig({
      provider: "none",
      vectorEnabled: false,
      cacheEnabled: true,
      sources: ["memory"],
    });
    const db = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" }).db;
    const open = sqliteRuntime.openOpenClawAgentSqliteWorkerStoreV2;
    const interceptedPaths: Array<string | undefined> = [];
    let closeSettled: boolean;
    const intercept = vi
      .spyOn(sqliteRuntime, "openOpenClawAgentSqliteWorkerStoreV2")
      .mockImplementation(async (...args) => {
        const [options, source, worker] = args;
        if (
          options.path !== db.location() ||
          worker.moduleUrl.href !==
            resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.publication).href
        ) {
          return await open(...args);
        }
        const client = await open(options, source, {
          ...worker,
          moduleUrl: resolveRuntimeWorkerUrl(memoryPublicationFaultEntrypoint),
          input: { kind: "cache-prune-result", publication: worker.input },
        });
        interceptedPaths.push(options.path);
        const close = client.close.bind(client);
        vi.spyOn(client, "close").mockImplementation(async () => {
          await close();
          closeSettled = true;
        });
        return client;
      });
    const manager = await fixture.getFreshManager(cfg, "cli");
    expect(managerDatabase(manager).location()).toBe(db.location());
    try {
      await manager.sync({ reason: "baseline", force: true });
      expect(interceptedPaths).toContain(db.location());
      const owner = manager as unknown as { cache: { maxEntries: number } };
      owner.cache.maxEntries = 2;
      const insert = db.prepare(`INSERT INTO memory_embedding_cache
        (provider, model, provider_key, hash, embedding, dims, updated_at)
        VALUES ('fixture', 'fixture', 'fixture', ?, ?, 1, ?)`);
      for (let index = 0; index < 331; index++) {
        insert.run(`cache-${index}`, encodeMemoryEmbedding([index + 1]), index);
      }
      const readCache = () =>
        db.prepare("SELECT * FROM memory_embedding_cache ORDER BY updated_at").all();
      const readSources = () => db.prepare("SELECT * FROM memory_index_sources ORDER BY id").all();
      const before = readCache();
      const sources = readSources();
      expect(before).toHaveLength(331);
      closeSettled = false;
      await expect(manager.sync({ reason: "watch" })).rejects.toThrow(
        "injected committed cache prune reply failure",
      );
      expect(closeSettled).toBe(true);
      const remaining = readCache();
      expect(remaining).toHaveLength(231);
      expect(remaining).toEqual(before.slice(100));
      expect(readSources()).toEqual(sources);

      intercept.mockRestore();
      await manager.sync({ reason: "explicit-prune-recovery" });
      expect(readCache()).toEqual(before.slice(-2));
      expect(readSources()).toEqual(sources);
    } finally {
      intercept.mockRestore();
      await manager.close();
    }
  });

  it.each(["unreleased", "replaced"] as const)(
    "preserves the %s shadow when final cleanup has no custody",
    async (failure) => {
      const manager = await fixture.getFreshManager(
        fixture.createConfig({ provider: "none", sources: ["memory"], vectorEnabled: false }),
      );
      const open = MemoryIndexDatabase.openShadow.bind(MemoryIndexDatabase);
      let shadow: { owner: MemoryIndexDatabase; path: string } | undefined;
      const releaseFailure = new Error("controlled shadow release failure");
      const replacement = "replacement file must survive rejected identity";
      vi.spyOn(MemoryIndexDatabase, "openShadow").mockImplementation(async (filename, ...args) => {
        const owner = await open(filename, ...args);
        shadow = { owner, path: filename };
        if (failure === "unreleased") {
          vi.spyOn(owner, "release").mockImplementation(() => {
            throw releaseFailure;
          });
        } else {
          const close = owner.closeShadow.bind(owner);
          let replaced = false;
          vi.spyOn(owner, "closeShadow").mockImplementation(async () => {
            await close();
            if (!replaced) {
              replaced = true;
              await fs.rename(filename, `${filename}.preserved`);
              await fs.writeFile(filename, replacement);
            }
          });
        }
        return owner;
      });
      try {
        await expect(manager.sync({ reason: "cli", force: true })).rejects.toThrow(
          failure === "unreleased" ? releaseFailure.message : "shadow file changed",
        );
        expect(shadow).toBeDefined();
        expect(shadow!.owner.shadowReleased).toBe(failure === "replaced");
        expect(shadow!.owner.db.isOpen).toBe(failure === "unreleased");
        if (failure === "unreleased") {
          expect((await fs.stat(shadow!.path)).isFile()).toBe(true);
        } else {
          expect(await fs.readFile(shadow!.path, "utf8")).toBe(replacement);
        }
      } finally {
        vi.restoreAllMocks();
        // The injected release failure deliberately leaves this fixture-owned handle open.
        if (shadow?.owner.db.isOpen) {
          shadow.owner.release();
        }
      }
    },
  );

  it("keeps closed-shadow cleanup pending while foreground callbacks run", async () => {
    const manager = await fixture.getFreshManager(
      fixture.createConfig({ provider: "none", sources: ["memory"], vectorEnabled: false }),
    );
    const open = MemoryIndexDatabase.openShadow.bind(MemoryIndexDatabase);
    let shadow: DatabaseSync | undefined;
    let shadowPath: string | undefined;
    vi.spyOn(MemoryIndexDatabase, "openShadow").mockImplementation(async (filename, ...args) => {
      shadowPath = filename;
      const owner = await open(filename, ...args);
      shadow = owner.db;
      return owner;
    });
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const remove = fs.rm;
    let removalStarted = false;
    vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      if (args[0] === shadowPath) {
        removalStarted = true;
        entered.resolve();
        await resume.promise;
      }
      return remove(...args);
    });
    let syncSettled = false;
    const sync = manager.sync({ reason: "cli", force: true }).finally(() => {
      syncSettled = true;
    });
    void sync.catch(() => undefined);
    let close: Promise<void> | undefined;
    let closed = false;
    try {
      await Promise.race([entered.promise, sync]);
      expect(removalStarted).toBe(true);
      expect(shadow?.isOpen).toBe(false);
      expect(syncSettled).toBe(false);
      await nextTurn();
      expect(manager.status().chunks).toBeGreaterThan(0);
      expect(syncSettled).toBe(false);
      close = manager.close().then(() => {
        closed = true;
      });
      await nextTurn();
      expect(closed).toBe(false);
      resume.resolve();
      await Promise.all([sync, close]);
      expect(shadowPath).toBeDefined();
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        await expect(fs.access(`${shadowPath}${suffix}`)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      resume.resolve();
      await Promise.allSettled([sync, close]);
    }
  });

  it("publishes a session while worker admission cannot read the shared connection", async () => {
    const sessionId = "admission-without-host-reads";
    const sessionKey = `agent:main:chat:${sessionId}`;
    const manager = await fixture.getFreshManager(
      fixture.createConfig({
        provider: "none",
        sources: ["sessions"],
        sessionMemory: true,
        vectorEnabled: false,
      }),
      "cli",
    );
    await manager.sync({ reason: "index-empty-corpus", force: true });
    await fixture.seedSessionTranscript({
      sessionId,
      sessionKey,
      messages: [{ role: "user", timestamp: 1, content: "Admitted violet fragment." }],
    });
    // Under rollback journaling a spilled publication holds EXCLUSIVE while it waits for
    // admission, so any host read on the agent database fails with SQLITE_BUSY.
    const unavailable = () => {
      throw Object.assign(new Error("database is locked"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 5,
      });
    };
    const withoutHostReads = (assertCurrent: () => void) => {
      const guards = [
        vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(unavailable),
        vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(unavailable),
        vi.spyOn(StatementSync.prototype, "all").mockImplementation(unavailable),
        vi.spyOn(StatementSync.prototype, "get").mockImplementation(unavailable),
        vi.spyOn(StatementSync.prototype, "iterate").mockImplementation(unavailable),
        vi.spyOn(StatementSync.prototype, "run").mockImplementation(unavailable),
      ];
      try {
        assertCurrent();
      } finally {
        for (const guard of guards) {
          guard.mockRestore();
        }
      }
    };
    // oxlint-disable-next-line typescript/unbound-method -- Called with the actual database owner.
    const replaceSource = MemoryIndexDatabase.prototype.replaceSource;
    vi.spyOn(MemoryIndexDatabase.prototype, "replaceSource").mockImplementation(function (
      this: MemoryIndexDatabase,
      replacement,
      assertCurrent,
      prepare,
    ) {
      return replaceSource.call(this, replacement, () => withoutHostReads(assertCurrent), prepare);
    });

    await manager.sync({
      reason: "admission-without-host-reads",
      sessions: [{ agentId: "main", sessionId, sessionKey }],
    });

    const published = readPublishedSessionIndex(
      managerDatabase(manager),
      `sessions/main/${sessionId}.jsonl`,
      "violet",
    );
    expect(published.chunks).toHaveLength(1);
    expect(published.search).toHaveLength(1);
  });
});
