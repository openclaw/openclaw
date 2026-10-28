import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildSessionEntry,
  listSessionTranscriptCorpusEntriesForAgent,
} from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  encodeMemoryEmbedding,
  MEMORY_CHUNKING_VERSION,
  type MemorySessionSyncTarget,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveRuntimeWorkerUrl, WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
import { deleteSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptEvents,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import { appendSqliteSessionTranscriptEventForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { assert, describe, expect, it, vi } from "vitest";
import { recordMemoryEntryOrigins } from "../memory-entry-origins.js";
import { forgetMemoryEntries } from "../memory-forget.js";
import { seedMemoryForgetTombstones } from "../test-helpers.js";
import { memoryCpuProcessEntrypoints } from "./manager-cpu-entrypoints.js";
import * as memoryCpuWorkerRuntime from "./manager-cpu-worker-runtime.js";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
  readPublishedSessionIndex,
} from "./manager-index.test-support.js";

const cacheHashes = (db: DatabaseSync) =>
  db.prepare("SELECT hash FROM memory_embedding_cache").all();
const sessionWindow = (db: DatabaseSync, sessionId: string) =>
  db.prepare("SELECT session_id FROM session_windows WHERE session_id = ?").get(sessionId);

function selectIndex(db: DatabaseSync, table: string, columns: string, suffix = "") {
  return db.prepare(`SELECT ${columns} FROM memory_index_${table} ${suffix}`);
}

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const openObserver = () =>
  new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }), { readOnly: true });
const chunksAt = (db: DatabaseSync, pathname: string) =>
  selectIndex(db, "chunks", "hash, text", "WHERE path = ?").all(pathname);

describe("memory session update sync", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { createConfig, getFreshManager, seedSessionTranscript } = fixture;
  const sessionConfig = (vectorEnabled?: boolean) =>
    createConfig({ provider: "none", sources: ["sessions"], sessionMemory: true, vectorEnabled });
  const batchConfig = () =>
    createConfig({
      provider: "batch-test",
      batchEnabled: true,
      vectorEnabled: false,
      cacheEnabled: true,
      sources: ["memory"],
    });
  const seed = (
    sessionId: string,
    sessionKey: string,
    content: string,
    role: "user" | "assistant" = "user",
    timestamp = 1,
  ) => seedSessionTranscript({ sessionId, sessionKey, messages: [{ role, timestamp, content }] });
  const recordOrigins = (sessionId: string, entryKeys: string[], agentId = "main") =>
    recordMemoryEntryOrigins({
      agentId,
      origins: entryKeys.map((entryKey) => ({
        agentId,
        sessionId,
        sessionKey: null,
        entryKey,
        originClass: "owner" as const,
        observedAt: Date.now(),
      })),
    });
  const sessionTarget = (sessionId: string, sessionKey: string) => ({
    agentId: "main",
    sessionId,
    sessionKey,
    storePath: path.join(resolveSessionTranscriptsDirForAgent("main"), "sessions.json"),
  });
  async function writePromotedFile(entryKey: string, fragment: string, filename = "MEMORY.md") {
    const filePath = path.join(fixture.paths.workspace, filename);
    const title = filename === "USER.md" ? "User" : "Memory";
    await fs.writeFile(
      filePath,
      `# ${title}\n<!-- openclaw-memory-promotion:${entryKey} -->\n- ${fragment}\n`,
    );
    return filePath;
  }
  const privateChunks = (db: DatabaseSync) =>
    selectIndex(db, "chunks", "text", "WHERE text LIKE '%Private violet%'").all();
  const expectPrivateDerivativesRemoved = (db: DatabaseSync, hashes: Set<unknown>) => {
    expect(privateChunks(db)).toEqual([]);
    expect(
      selectIndex(db, "chunks_fts", "id", "WHERE memory_index_chunks_fts MATCH ?").all("violet"),
    ).toEqual([]);
    expect(cacheHashes(db).filter((row) => hashes.has(row.hash))).toEqual([]);
  };

  function seedIndexedSession(db: DatabaseSync, sessionPath: string, text: string): void {
    db.prepare(
      "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, 'sessions', ?, ?, ?)",
    ).run(sessionPath, "stale-session", 10, 20);
    db.prepare(
      "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, 'sessions', 1, 1, 'stale-chunk', 'fts-only', ?, ?, 10)",
    ).run(sessionPath, sessionPath, text, encodeMemoryEmbedding([]));
    db.prepare(
      "INSERT INTO memory_index_chunk_provenance (chunk_id, origin_class, session_kind, observed_at) VALUES (?, 'owner', 'unknown', ?)",
    ).run(sessionPath, 10);
  }

  function expectSessionIndexRemoved(db: DatabaseSync, sessionPath: string): void {
    expect(readPublishedSessionIndex(db, sessionPath, "violet")).toEqual({
      source: undefined,
      chunks: [],
      search: [],
    });
  }
  const forget = (cfg: ReturnType<typeof createConfig>, sessionId: string, agentId = "main") =>
    forgetMemoryEntries({ cfg, agentId, sessionIds: [sessionId] });
  const expectFilePurged = async (file: string) =>
    expect(await fs.readFile(file, "utf8")).not.toContain("Private violet");

  it("preserves the published session index when worker admission is full and retries after cooldown", async () => {
    const sessionId = "worker-capacity-reindex";
    const sessionKey = `agent:main:chat:${sessionId}`;
    const sessionPath = `sessions/main/${sessionId}.jsonl`;
    await seed(sessionId, sessionKey, "Published violet preference.");
    const manager = await getFreshManager(sessionConfig(false), "cli");
    await manager.sync({ reason: "before-worker-overload", force: true });
    using observer = openObserver();
    const snapshot = () => readPublishedSessionIndex(observer, sessionPath, "violet");
    const before = snapshot();
    expect(before.source).toBeDefined();
    expect(before.chunks).toHaveLength(1);
    expect(before.search).toHaveLength(1);
    await seed(sessionId, sessionKey, "New violet response after publication.", "assistant", 2);
    const capacityOwner = new WorkerTaskPool({
      workerUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.index),
      maxWorkers: 1,
      sharedCompute: true,
    });
    const preparation = createDeferred<never>();
    const accepted = Promise.allSettled(
      Array.from({ length: 128 }, () => capacityOwner.run(() => preparation.promise, {})),
    );
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      try {
        await expect(
          manager.sync({ reason: "worker-overload", force: true }),
        ).rejects.toMatchObject({ name: "WorkerTaskError", code: "overloaded" });
        expect(snapshot()).toEqual(before);
        expect(manager.status().dirty).toBe(true);
        expect(manager.status().lastSyncError).toContain("worker task capacity reached");
      } finally {
        const closed = capacityOwner.close();
        preparation.reject(new Error("release test capacity"));
        await closed;
        await accepted;
      }
      clock.mockReturnValue(now + 30_000);
      await manager.sync({ reason: "retry-after-worker-overload" });
      const recovered = snapshot();
      expect(recovered.source?.hash).not.toBe(before.source?.hash);
      for (const rows of [recovered.chunks, recovered.search]) {
        expect(rows.map((chunk) => chunk.text).join("\n")).toContain(
          "New violet response after publication.",
        );
      }
      expect(manager.status()).toMatchObject({ dirty: false, lastSyncError: undefined });
    } finally {
      clock.mockRestore();
    }
  });

  it.each(["session update", "unchanged legacy index"] as const)(
    "preserves reset recall boundaries after %s",
    async (mode) => {
      const sessionId = "reset-index-boundary";
      const sessionKey = `agent:main:chat:${sessionId}`;
      const target = sessionTarget(sessionId, sessionKey);
      const owner = { role: "user" as const, senderIsOwner: true };
      await seedSessionTranscript({
        sessionId,
        sessionKey,
        messages: [
          { ...owner, timestamp: 1, content: "Earlier owner preference." },
          { role: "assistant", timestamp: 2, content: "Earlier derived answer." },
          { ...owner, timestamp: 3, content: "Retained owner preference." },
          { role: "assistant", timestamp: 4, content: "Retained derived answer." },
        ],
      });
      const cfg = sessionConfig();
      let manager = await getFreshManager(cfg, "cli");
      await manager.sync({ reason: "before-reset", force: true });
      const messages = (await readSessionTranscriptEvents(target)).flatMap((record, index) => {
        const event = asOptionalRecord(record);
        return event?.type === "message" && typeof event.id === "string"
          ? [{ id: event.id, line: index + 1 }]
          : [];
      });
      expect(messages).toHaveLength(4);
      await appendSqliteSessionTranscriptEventForTest({
        ...target,
        event: {
          type: "reset",
          id: "reset-boundary",
          parentId: messages[3]!.id,
          firstKeptEntryId: messages[2]!.id,
          reason: "reset",
          timestamp: "2026-09-01T00:00:00.000Z",
        },
      });
      const unchangedTranscript = await readSessionTranscriptEvents(target);
      let expectedSourceHash: string | undefined;
      if (mode === "unchanged legacy index") {
        const corpus = (await listSessionTranscriptCorpusEntriesForAgent("main")).find(
          (entry) => entry.sessionId === sessionId,
        );
        assert.isDefined(corpus, "Expected the reset-bearing session in the corpus");
        const entry = await buildSessionEntry(corpus.sessionFile, {
          ...target,
          sessionKind: corpus.sessionKind,
          updatedAtMs: corpus.updatedAtMs,
        });
        assert.isNotNull(entry, "Expected the reset-bearing session export");
        const db = Reflect.get(manager, "db") as DatabaseSync;
        // Revision 4 retained the reset-aware source hash but indexed one crossing
        // chunk because spreading the entry discarded its non-enumerable cutoff.
        expect(
          db
            .prepare(
              "SELECT start_line, end_line FROM memory_index_chunks WHERE path = ? AND source = 'sessions'",
            )
            .all(entry.path),
        ).toEqual([{ start_line: messages[0]!.line, end_line: messages[3]!.line }]);
        const writer = memoryIndexFixtureWriter(manager);
        writer
          .prepare(
            "UPDATE memory_index_sources SET hash = ?, mtime = ?, size = ? WHERE path = ? AND source = 'sessions'",
          )
          .run(entry.hash, entry.mtimeMs, entry.size, entry.path);
        writer
          .prepare(
            "UPDATE memory_index_meta SET value = json_set(value, '$.chunkingVersion', 4) WHERE key = 'memory_index_meta_v1'",
          )
          .run();
        expectedSourceHash = `sqlite:${entry.revisionMs}:${entry.hash}`;
        await manager.close();
        manager = await getFreshManager(cfg, "cli");
        await manager.sync({ reason: "watch" });
      } else {
        await manager.sync({ reason: "after-reset", sessions: [{ sessionId, sessionKey }] });
      }

      using observer = openObserver();

      const chunks = observer
        .prepare(
          "SELECT start_line, end_line, text FROM memory_index_chunks WHERE source = 'sessions' AND path = ? ORDER BY start_line, end_line",
        )
        .all(`sessions/main/${sessionId}.jsonl`);
      expect(chunks).toEqual([
        {
          start_line: messages[0]!.line,
          end_line: messages[1]!.line,
          text: "User: Earlier owner preference.\nAssistant: Earlier derived answer.",
        },
        {
          start_line: messages[2]!.line,
          end_line: messages[3]!.line,
          text: "User: Retained owner preference.\nAssistant: Retained derived answer.",
        },
      ]);
      if (expectedSourceHash !== undefined) {
        expect(
          observer
            .prepare("SELECT hash FROM memory_index_sources WHERE path = ? AND source = 'sessions'")
            .get(`sessions/main/${sessionId}.jsonl`)?.hash,
        ).toBe(expectedSourceHash);
        expect(
          observer
            .prepare(
              "SELECT json_extract(value, '$.chunkingVersion') AS version FROM memory_index_meta WHERE key = 'memory_index_meta_v1'",
            )
            .get()?.version,
        ).toBe(MEMORY_CHUNKING_VERSION);
      }

      expect(await readSessionTranscriptEvents(target)).toEqual(unchangedTranscript);
      expect(manager.status().dirty).toBe(false);
    },
  );

  it("indexes an update that arrives before an active sync clears dirty state", async () => {
    const sessionId = "session-update-during-sync";
    const sessionKey = `agent:main:proof:${sessionId}`;
    const updatedMarker = "UPDATE DURING ACTIVE SYNC 811";
    const manager = await getFreshManager(sessionConfig(), "cli");
    const owner = manager as unknown as {
      sessionPendingTargets: Map<string, MemorySessionSyncTarget>;
      sessionsDirty: boolean;
      sessionsReconcileDirty: boolean;
      syncArchiveFiles: (params: unknown) => Promise<void>;
      processSessionUpdateBatch: () => Promise<void>;
    };
    const activeSyncGate = createDeferred<void>();
    const activeSyncIndexed = createDeferred<void>();
    let sessionUpdateBatch: Promise<void> | undefined;
    let syncArchiveFilesSpy: { mockRestore: () => void } | undefined;
    try {
      await seed(sessionId, sessionKey, "initial transcript", "user", Date.now());
      await manager.sync({ reason: "test-baseline", force: true });

      owner.sessionsDirty = true;
      owner.sessionsReconcileDirty = true;
      const syncArchiveFiles = owner.syncArchiveFiles.bind(manager);
      syncArchiveFilesSpy = vi
        .spyOn(owner, "syncArchiveFiles")
        .mockImplementationOnce(async (params) => {
          await syncArchiveFiles(params);
          activeSyncIndexed.resolve();
          await activeSyncGate.promise;
        });
      const activeSync = manager.sync({ reason: "test-active" });
      await activeSyncIndexed.promise;

      await seed(sessionId, sessionKey, updatedMarker, "assistant", Date.now());
      owner.sessionPendingTargets.set(sessionKey, { agentId: "main", sessionId, sessionKey });
      sessionUpdateBatch = owner.processSessionUpdateBatch();

      activeSyncGate.resolve();
      await activeSync;
      await sessionUpdateBatch;

      using observer = openObserver();
      const row = selectIndex(
        observer,
        "chunks",
        "COUNT(*) AS count",
        "WHERE source = 'sessions' AND text LIKE ?",
      ).get(`%${updatedMarker}%`) as { count: number };
      expect(row.count).toBeGreaterThan(0);
      expect(manager.status().dirty).toBe(false);
    } finally {
      syncArchiveFilesSpy?.mockRestore();
      activeSyncGate.resolve();
      await sessionUpdateBatch?.catch(() => undefined);
      await manager.close?.();
    }
  });

  it("prunes a real compressed unchanged narrative archive through regular reconciliation", async () => {
    const sessionId = "3cb3f634-6821-4123-8123-abcdef123456";
    const sessionKey = "agent:main:dreaming-narrative-memory-core-v2-light-real";
    const target = sessionTarget(sessionId, sessionKey);
    const sessionsDir = path.dirname(target.storePath);
    await seed(sessionId, sessionKey, "Previously retained violet fragment.", "user", Date.now());
    await appendSessionTranscriptMessageByIdentity({
      ...target,
      message: {
        role: "assistant",
        timestamp: Date.now(),
        content: [{ type: "text", text: "A narrative derived from that violet fragment." }],
        __openclaw: { runId: "dreaming-narrative-main-light-real" },
      },
    });
    await expect(
      deleteSessionEntry({
        ...target,
        archiveTranscript: true,
        expectedSessionId: sessionId,
      }),
    ).resolves.toBe(true);
    const archiveName = (await fs.readdir(sessionsDir)).find(
      (name) => name.startsWith(`${sessionId}.jsonl.deleted.`) && name.endsWith(".zst"),
    );
    expect(archiveName).toBeDefined();
    const manager = await getFreshManager(sessionConfig(), "cli", true);
    expect(manager.status().sourceCounts?.find((source) => source.source === "sessions")).toEqual(
      expect.objectContaining({ eligible: 0 }),
    );
    const db = Reflect.get(manager, "db") as DatabaseSync;
    const sessionPath = `sessions/main/${archiveName}`;
    expect(sessionWindow(db, sessionId)).toBeUndefined();
    expect(
      (await listSessionTranscriptCorpusEntriesForAgent("main")).find(
        (entry) => entry.sessionId === sessionId,
      ),
    ).toMatchObject({ artifactKind: "archive-artifact", sessionKind: "unknown" });
    const fixtureWriter = memoryIndexFixtureWriter(manager);
    seedIndexedSession(fixtureWriter, sessionPath, "Previously retained violet fragment");
    const archiveStat = await fs.stat(path.join(sessionsDir, archiveName!));
    fixtureWriter
      .prepare("UPDATE memory_index_sources SET mtime = ?, size = ? WHERE path = ?")
      .run(archiveStat.mtimeMs, archiveStat.size, sessionPath);

    await (
      manager as unknown as { runSessionStartupCatchup: () => Promise<string[]> }
    ).runSessionStartupCatchup();
    await manager.sync({ reason: "await-startup-catchup" });

    expectSessionIndexRemoved(db, sessionPath);
  });

  it("never reindexes a tombstoned session while preserving its source transcript", async () => {
    const sessionId = "forgotten-transcript";
    const sessionKey = `agent:main:chat:${sessionId}`;
    const decoyId = "unselected-transcript";
    const decoyKey = `agent:main:chat:${decoyId}`;
    await seed(sessionId, sessionKey, "Previously indexed violet fragment.", "user", Date.now());
    await seed(decoyId, decoyKey, "Previously indexed amber fragment.");
    const manager = await getFreshManager(sessionConfig(), "cli");
    const db = Reflect.get(manager, "db") as DatabaseSync;
    const sessionPath = `sessions/main/${sessionId}.jsonl`;
    const reads = vi.spyOn(memoryCpuWorkerRuntime, "runMemoryIndexRead");
    try {
      await manager.sync({ reason: "index-before-forget", force: true });
      // Live publication enforces forget authority without one preflight request per session.
      expect(reads.mock.calls.map(([, command]) => command.type)).not.toContain("session.current");
    } finally {
      reads.mockRestore();
    }
    expect(selectIndex(db, "chunks", "path", "WHERE path = ?").get(sessionPath)).toEqual({
      path: sessionPath,
    });

    seedMemoryForgetTombstones({ agentId: "main", sessionIds: [sessionId] });
    await manager.sync({ reason: "forced-reindex-after-forget", force: true });

    expectSessionIndexRemoved(db, sessionPath);
    expect(sessionWindow(db, sessionId)).toEqual({ session_id: sessionId });
    const decoyPath = `sessions/main/${decoyId}.jsonl`;
    const decoyBefore = readPublishedSessionIndex(db, decoyPath, "amber");
    expect(decoyBefore.chunks).toHaveLength(1);
    await seed(decoyId, decoyKey, "Unselected new amber response.", "assistant", 2);
    const selectedId = "selected-transcript";
    const selectedKey = `agent:main:chat:${selectedId}`;
    await seed(selectedId, selectedKey, "Selected new violet fragment.");
    await manager.sync({
      reason: "targeted-update-after-forget",
      sessions: [
        { agentId: "main", sessionId, sessionKey },
        { agentId: "main", sessionId: selectedId, sessionKey: selectedKey },
        { agentId: "main", sessionId: decoyId, sessionKey: "wrong-session-key" },
        { agentId: "other", sessionId: decoyId, sessionKey: decoyKey },
        { sessionId: selectedId },
        { sessionId: " " },
      ],
    });
    expectSessionIndexRemoved(db, sessionPath);
    expect(readPublishedSessionIndex(db, decoyPath, "amber")).toEqual(decoyBefore);
    const selected = readPublishedSessionIndex(db, `sessions/main/${selectedId}.jsonl`, "violet");
    expect(selected.chunks).toHaveLength(1);
    expect(selected.search).toHaveLength(1);
    expect(selected.chunks[0]?.text).toContain("Selected new violet fragment.");
  });

  it.each([
    { mode: "incremental embeddings", force: false, repeatPurge: false },
    { mode: "full reindex embeddings", force: true, repeatPurge: false },
    { mode: "completed shadow before repeat purge", force: true, repeatPurge: true },
  ])("does not publish a stale workspace file after $mode", async ({ force, repeatPurge }) => {
    const cfg = batchConfig();
    const baseline = await getFreshManager(cfg, "cli");
    await baseline.sync({ reason: "index-before-new-memory", force: true });
    await baseline.close();
    const sessionId = "forgotten-memory-source";
    const memoryPath = await writePromotedFile("private-entry", "Private violet alpha fragment.");
    await recordOrigins(sessionId, ["private-entry"]);
    if (repeatPurge) {
      // An earlier purge persisted its tombstone but failed before rewriting
      // this previously unindexed file. Retrying must fence a completed shadow.
      seedMemoryForgetTombstones({ agentId: "main", sessionIds: [sessionId] });
    }
    const manager = await getFreshManager(cfg, "cli", true);
    const embeddingGate = createDeferred<void>();
    const privateSourceReady = createDeferred<void>();
    if (!repeatPurge) {
      fixture.provider.providerRuntimeBatchEntered = (_activeCalls, texts) => {
        if (texts.some((text) => text.includes("Private violet alpha fragment"))) {
          fixture.provider.providerRuntimeBatchGate = embeddingGate.promise;
          privateSourceReady.resolve();
        }
      };
    }
    let purge: ReturnType<typeof forgetMemoryEntries> | undefined;
    const activeSync = manager.sync({
      reason: "forget-during-file-index",
      force,
      progress: ({ completed, total }) => {
        if (repeatPurge && total > 0 && completed === total && !purge) {
          purge = forget(cfg, sessionId);
          void purge.catch(() => undefined);
        }
      },
    });
    void activeSync.catch(() => undefined);
    try {
      if (!repeatPurge) {
        await Promise.race([privateSourceReady.promise, activeSync]);
        expect(fixture.provider.providerRuntimeBatchGate).toBe(embeddingGate.promise);
        await forget(cfg, sessionId);
        embeddingGate.resolve();
      }
      if (force) {
        await expect(activeSync).rejects.toThrow("full reindex was building");
      } else {
        await expect(activeSync).resolves.toBeUndefined();
      }
      await purge;
      await expectFilePurged(memoryPath);
      const db = Reflect.get(manager, "db") as DatabaseSync;
      expect(chunksAt(db, "MEMORY.md")).toEqual([]);
      expect(manager.status().dirty).toBe(true);
      await manager.sync({ reason: "retry-after-memory-forget", force: true });
      expect(manager.status().dirty).toBe(false);
      expect(privateChunks(db)).toEqual([]);
    } finally {
      embeddingGate.resolve();
      await activeSync.catch(() => undefined);
      await purge?.catch(() => undefined);
      fixture.provider.providerRuntimeBatchGate = null;
      fixture.provider.providerRuntimeBatchEntered = null;
    }
  });

  it("removes cached private data when reindexing runs between an interrupted purge and retry", async () => {
    const cfg = batchConfig();
    const sessionId = "interrupted-memory-source";
    const memoryPath = await writePromotedFile("private-first", "Private violet alpha fragment.");
    const userPath = await writePromotedFile(
      "private-second",
      "Private violet beta fragment.",
      "USER.md",
    );
    await recordOrigins(sessionId, ["private-first", "private-second"]);
    const manager = await getFreshManager(cfg, "cli");
    await manager.sync({ reason: "index-before-interrupted-purge", force: true });
    const db = Reflect.get(manager, "db") as DatabaseSync;
    const privateHashes = new Set(
      selectIndex(db, "chunks", "hash", "WHERE text LIKE '%Private violet%'")
        .all()
        .map((row) => row.hash),
    );
    expect(privateHashes.size).toBe(2);

    const open = fs.open.bind(fs);
    const memoryTempPrefix = `${memoryPath}.forget.`;
    const fault = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const target = args[0];
      if (typeof target === "string" && target.startsWith(memoryTempPrefix)) {
        throw new Error("interrupted after memory rewrite");
      }
      return await open(...args);
    });
    try {
      await expect(forget(cfg, sessionId)).rejects.toThrow("interrupted after memory rewrite");
    } finally {
      fault.mockRestore();
    }
    // The interrupted rewrite is atomic: MEMORY.md keeps its original content
    // until the retry completes the purge.
    expect(await fs.readFile(memoryPath, "utf8")).toContain("Private violet alpha");
    expect(await fs.readFile(userPath, "utf8")).toContain("Private violet beta");

    // A rebuild can drop a cleaned file's old chunk while retaining its cached
    // embedding. The purge must remove derivatives before losing their source.
    await manager.sync({ reason: "reindex-before-purge-retry", force: true });
    expect(
      selectIndex(db, "chunks", "id", "WHERE text LIKE '%Private violet beta%'").all(),
    ).not.toEqual([]);
    await forget(cfg, sessionId);

    await expectFilePurged(memoryPath);
    await expectFilePurged(userPath);
    expectPrivateDerivativesRemoved(db, privateHashes);
  });

  it("purges a stale agent index after a sibling already removed their shared memory entry", async () => {
    const cfg = batchConfig();
    cfg.agents = {
      ...cfg.agents,
      entries: {
        main: { workspace: fixture.paths.workspace },
        peer: { workspace: fixture.paths.workspace },
      },
    };
    const memoryPath = await writePromotedFile("shared-private", "Private violet shared fragment.");
    for (const agentId of ["main", "peer"]) {
      await recordOrigins(`source-${agentId}`, ["shared-private"], agentId);
    }
    const main = await getFreshManager(cfg, "cli");
    const peer = fixture.requireManager(
      await getMemorySearchManager({ cfg, agentId: "peer", purpose: "cli" }),
    );
    fixture.trackManager(peer);
    await main.sync({ reason: "index-shared-memory", force: true });
    await peer.sync({ reason: "index-shared-memory", force: true });
    const db = Reflect.get(peer, "db") as DatabaseSync;
    const snapshot = chunksAt(db, "MEMORY.md");
    expect(snapshot.some((row) => String(row.text).includes("Private violet"))).toBe(true);
    expect(
      snapshot.some((row) => String(row.text).includes("openclaw-memory-promotion:shared-private")),
    ).toBe(true);
    const privateHashes = new Set(snapshot.map((row) => row.hash));
    expect(cacheHashes(db).some((row) => privateHashes.has(row.hash))).toBe(true);

    await forget(cfg, "source-main");
    await expectFilePurged(memoryPath);
    // The first purge owns only main's database. Peer must use its retained
    // snapshot when its own explicit purge finds the shared file already clean.
    expect(chunksAt(db, "MEMORY.md")).toEqual(snapshot);

    const forgotten = await forget(cfg, "source-peer", "peer");
    expect(forgotten.artifacts).toMatchObject({ memoryFiles: 0, indexChunks: snapshot.length });
    expect(chunksAt(db, "MEMORY.md")).toEqual([]);
    expectPrivateDerivativesRemoved(db, privateHashes);
  });

  it("skips unchanged session metadata and observes later committed appends", async () => {
    const sessionId = "unchanged-session-metadata";
    const sessionKey = `agent:main:chat:${sessionId}`;
    const sessionPath = `sessions/main/${sessionId}.jsonl`;
    await seed(sessionId, sessionKey, "Original violet preference.");
    const manager = await getFreshManager(sessionConfig(false), "cli");
    await manager.sync({ reason: "baseline", force: true });
    using observer = openObserver();
    const before = readPublishedSessionIndex(observer, sessionPath, "violet");
    const refresh = vi.spyOn(MemoryIndexDatabase.prototype, "refreshSourceState");
    try {
      await manager.sync({ reason: "duplicate-update", sessions: [{ sessionId, sessionKey }] });
      expect(refresh).not.toHaveBeenCalled();
      expect(readPublishedSessionIndex(observer, sessionPath, "violet")).toEqual(before);

      await seed(sessionId, sessionKey, "New violet preference.", "assistant", 2);
      await manager.sync({ reason: "committed-update", sessions: [{ sessionId, sessionKey }] });
      const after = readPublishedSessionIndex(observer, sessionPath, "violet");
      expect(after.source).not.toEqual(before.source);
      expect(
        after.chunks.some((chunk) => String(chunk.text).includes("New violet preference.")),
      ).toBe(true);
    } finally {
      refresh.mockRestore();
    }
  });

  it.each(["absent", "replaced"] as const)(
    "cleans system-only archives when source is %s",
    async (sourceState) => {
      const archiveName = "internal-turn.jsonl.deleted.2026-08-26T11-00-00.000Z";
      const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
      await fs.mkdir(sessionsDir, { recursive: true });
      const record = {
        type: "message",
        message: {
          role: "user",
          content: "Internal system-generated fragment",
          provenance: { kind: "internal_system", sourceTool: "internal-maintenance" },
        },
      };
      const archivePath = path.join(sessionsDir, archiveName);
      await fs.writeFile(archivePath, JSON.stringify(record) + "\n");
      const manager = await getFreshManager(sessionConfig(), "cli");
      await manager.sync({ reason: "forced-reindex", force: true });
      const db = Reflect.get(manager, "db") as DatabaseSync;
      expect(selectIndex(db, "chunks", "DISTINCT path", "WHERE source = 'sessions'").all()).toEqual(
        [],
      );
      const sessionPath = `sessions/main/${archiveName}`;
      const writer = memoryIndexFixtureWriter(manager);
      seedIndexedSession(writer, sessionPath, "Stale violet internal fragment.");
      // Forget can leave chunks without a source row; published cleanup still owns them.
      writer.prepare("DELETE FROM memory_index_sources WHERE path = ?").run(sessionPath);
      const orphaned = readPublishedSessionIndex(db, sessionPath, "violet");
      // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted database receiver.
      const readSourceState = MemoryIndexDatabase.prototype.readSourceState;
      const inventory = vi
        .spyOn(MemoryIndexDatabase.prototype, "readSourceState")
        .mockImplementation(async function (this: MemoryIndexDatabase, query) {
          const rows = await readSourceState.call(this, query);
          if (query.paths?.includes(sessionPath)) {
            expect(rows).toEqual([]);
            if (sourceState === "replaced") {
              writer
                .prepare(
                  "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, 'sessions', 'newer-session', 30, 40)",
                )
                .run(sessionPath);
            }
          }
          return rows;
        });
      try {
        await manager.sync({ reason: "archive-cleanup", archiveFiles: [archivePath] });
        if (sourceState === "replaced") {
          const retained = readPublishedSessionIndex(db, sessionPath, "violet");
          expect(retained.source?.hash).toBe("newer-session");
          expect(retained.chunks).toEqual(orphaned.chunks);
          expect(retained.search).toEqual(orphaned.search);
        } else {
          expectSessionIndexRemoved(db, sessionPath);
        }
      } finally {
        inventory.mockRestore();
      }
    },
  );

  it("excludes heartbeat transcripts from targeted memory indexing", async () => {
    const sessionId = "system-thread";
    const sessionKey = "agent:main:heartbeat:run-1";
    await seed(sessionId, sessionKey, "Internal system output.", "assistant", Date.now());
    await upsertSessionEntry({
      ...sessionTarget(sessionId, sessionKey),
      entry: {
        sessionId,
        updatedAt: Date.now(),
        heartbeatIsolatedBaseSessionKey: "agent:main:chat:base",
      },
    });
    const manager = await getFreshManager(sessionConfig(), "cli");

    await manager.sync({
      reason: "targeted-generated-session",
      sessions: [{ agentId: "main", sessionId, sessionKey }],
    });

    const database = Reflect.get(manager, "db") as DatabaseSync;
    expect(selectIndex(database, "chunks", "path", "WHERE source = 'sessions'").all()).toEqual([]);
  });
});
