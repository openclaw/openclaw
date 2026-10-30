import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as sessionMetadata from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  encodeMemoryEmbedding,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  deleteSessionEntry,
  getSessionEntryAsync,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./manager-index.test-support.js";
import * as knn from "./manager-search-knn.js";
import { insertKeywordFixture } from "./manager-search.test-support.js";

const fixture = createManagerIndexFixture(await import("./index.js"));

const originalHelperId = "active-memory-mabc123-1a2b3c4d";
const liveHelperId = "03b3e791-f9cc-4dbb-a806-b6ae72441042";
const archivedHelperId = "661212b2-d245-48e8-adea-df73ed01dc94";
const unknownArchiveId = "f9049e61-d1b9-4d35-b865-b1951670ec8a";
const unknownArchiveName = `${unknownArchiveId}.jsonl.reset.2026-08-09T00-00-00.000Z`;
const ordinaryPath = "sessions/main/ordinary-conversation.jsonl";
const unknownArchivePath = `sessions/main/${unknownArchiveName}`;
const memoryFilePath = `memory/${originalHelperId}.md`;
const helperPath = `sessions/main/${originalHelperId}.jsonl`;
const expectedPaths = [memoryFilePath, ordinaryPath, unknownArchivePath].toSorted();
type RetrievalMode = "keyword-only" | "hybrid KNN" | "hybrid embedding scan";
type Writer = ReturnType<typeof memoryIndexFixtureWriter>;
type Manager = Awaited<ReturnType<typeof fixture.getFreshManager>>;
const lexicalOptions = { lexicalOnly: true };
const resultPaths = (entries: { path: string }[]) => entries.map((entry) => entry.path).toSorted();
const sessionPath = (id: string) => `sessions/main/${id}.jsonl`;
const countHelpers = (writer: Writer) =>
  writer
    .prepare("SELECT COUNT(*) AS n FROM memory_index_chunks WHERE path = ? AND source = 'sessions'")
    .get(helperPath);
const sessionSources = (writer: Writer, columns = "path") =>
  writer
    .prepare(`SELECT ${columns} FROM memory_index_sources WHERE source = 'sessions' ORDER BY path`)
    .all();

function helperRows(writer: Writer, table: string, columns: string) {
  return writer
    .prepare(`SELECT ${columns} FROM ${table} WHERE path = ? AND source = 'sessions'`)
    .all(helperPath);
}
function validRows(writer: Writer, table: "chunks" | "sources", columns: string, order: string) {
  return writer
    .prepare(
      `SELECT ${columns} FROM memory_index_${table} WHERE path IN (?, ?, ?) ORDER BY ${order}`,
    )
    .all(...expectedPaths);
}
function expectHelperPruned(writer: Writer) {
  expect(helperRows(writer, "memory_index_sources", "path")).toEqual([]);
  expect(helperRows(writer, "memory_index_chunks", "id")).toEqual([]);
}

afterEach(() => vi.restoreAllMocks());
const sessionScope = (sessionKey: string) => ({
  agentId: "main",
  sessionKey,
  storePath: path.join(resolveSessionTranscriptsDirForAgent("main"), "sessions.json"),
});
const archivedSessions = (sessionId: string) =>
  sessionMetadata.loadArchivedSessionsAsync({ ...sessionScope(""), sessionIds: [sessionId] });
const setOwnership = (sessionId: string, sessionKey: string, pluginOwnerId?: string) =>
  upsertSessionEntry({
    ...sessionScope(sessionKey),
    entry: { sessionId, updatedAt: Date.now(), ...(pluginOwnerId ? { pluginOwnerId } : {}) },
  });
async function archive(sessionId: string, sessionKey: string) {
  await expect(
    deleteSessionEntry({
      ...sessionScope(sessionKey),
      expectedSessionId: sessionId,
      archiveTranscript: true,
    }),
  ).resolves.toBe(true);
  const name = (await fs.readdir(resolveSessionTranscriptsDirForAgent("main"))).find((entry) =>
    entry.startsWith(`${sessionId}.jsonl.deleted.`),
  );
  expect(name, "The real deletion did not produce an archive").toBeDefined();
  return name;
}
const search = (manager: Manager) => manager.search("alpha", lexicalOptions);
const seedTranscript = (sessionId: string, sessionKey: string, content: string) =>
  fixture.seedSessionTranscript({
    sessionId,
    sessionKey,
    messages: [{ role: "user", timestamp: Date.now(), content }],
  });
const managerConfig = (overrides: Parameters<typeof fixture.createConfig>[0]) =>
  fixture.createConfig({
    provider: "none",
    sources: ["sessions"],
    rememberAcrossConversations: true,
    vectorEnabled: false,
    ...overrides,
  });
const sessionsManager = (minScore?: number) =>
  fixture.getFreshManager(managerConfig({ minScore }), "cli");

async function pollutedIndex(mode: RetrievalMode) {
  const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
  const archivedHelperKey = "agent:main:explicit:laptop:active-memory:0123456789ab";
  for (const [sessionId, sessionKey] of [
    ["ordinary-conversation", "agent:main:explicit:ordinary"],
    [liveHelperId, "agent:main:explicit:phone:active-memory:abcdef123456"],
    [archivedHelperId, archivedHelperKey],
  ] as const) {
    await seedTranscript(sessionId, sessionKey, "Alpha beta ordinary fact.");
  }
  const archivedHelperName = await archive(archivedHelperId, archivedHelperKey);
  await fs.writeFile(
    path.join(sessionsDir, unknownArchiveName),
    `${JSON.stringify({
      type: "message",
      message: { role: "user", content: "Alpha beta unidentified historical conversation." },
    })}\n`,
  );
  await fs.rm(path.join(fixture.paths.memory, "2026-01-12.md"));
  await fs.writeFile(
    path.join(fixture.paths.workspace, memoryFilePath),
    "Alpha beta ordinary notes quoting an Active Memory session identifier.",
  );
  const cfg = managerConfig({
    provider: mode === "keyword-only" ? "none" : "openai",
    sources: ["memory", "sessions"],
    vectorEnabled: mode === "hybrid KNN",
    minScore: 0,
  });
  const manager = await fixture.getFreshManager(cfg, "cli");
  await manager.sync({ reason: "prepare-valid-index", force: true });
  expect(manager.status().fts?.available).toBe(true);
  const writer = memoryIndexFixtureWriter(manager);
  if (mode === "hybrid KNN") {
    const loaded = await loadSqliteVecExtension({ db: writer });
    expect(loaded.ok, loaded.error).toBe(true);
  }
  const model = mode === "keyword-only" ? "fts-only" : "mock-embed";
  const insertHistoricalChunk = (id: string, pathname: string, line = 1) => {
    insertKeywordFixture(writer, {
      id,
      path: pathname,
      source: "sessions",
      model,
      text: "Alpha alpha alpha alpha internal recall example.",
      startLine: line,
      endLine: line,
    });
    writer
      .prepare("UPDATE memory_index_chunks SET embedding = ? WHERE id = ?")
      .run(encodeMemoryEmbedding([1, 0, 0, 0]), id);
    if (mode === "hybrid KNN") {
      writer
        .prepare("INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)")
        .run(id, Buffer.from(new Float32Array([1, 0, 0, 0]).buffer));
    }
  };
  // Bypass admission with >200 rows to catch filtering after the candidate LIMIT.
  for (let index = 0; index < 201; index++) {
    insertHistoricalChunk(`historical-helper-${index}`, helperPath, index + 1);
  }
  const archivedHelperPath = `sessions/main/${archivedHelperName}`;
  for (const [index, pathname] of [
    `sessions/main/${originalHelperId}`,
    `sessions/main/${liveHelperId}.jsonl`,
    archivedHelperPath,
    `sessions/main/${originalHelperId}.jsonl.deleted.2026-08-09T00-00-00.000Z`,
    `sessions/main/${originalHelperId}.jsonl.reset.2026-08-09T00-00-00.000Z.0123456789abcdef0123456789abcdef.zst`,
  ].entries()) {
    insertHistoricalChunk(`historical-identity-${index}`, pathname);
  }
  expect(countHelpers(writer)).toEqual({ n: 201 });
  expect(
    writer
      .prepare(
        "SELECT COUNT(*) AS n FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH 'alpha'",
      )
      .get()?.n,
  ).toBeGreaterThan(200);
  return { manager, writer };
}

it.for<RetrievalMode>(["keyword-only", "hybrid KNN", "hybrid embedding scan"])(
  "excludes old helper chunks before %s limits and preserves ordinary and unknown conversations",
  async (mode, { signal }) => {
    const { manager, writer } = await pollutedIndex(mode);
    const nativeKnn = vi.spyOn(knn, "searchMemoryVectorIndex");
    const validIndex = () => ({
      chunks: validRows(writer, "chunks", "id, path, hash, embedding, updated_at", "id"),
      sources: validRows(writer, "sources", "path, source, hash, mtime, size", "path"),
    });
    const beforeIndex = validIndex();
    const embeddingBatches = fixture.provider.embedBatchCalls;
    const releaseCleanup = createDeferred<void>();
    // oxlint-disable-next-line typescript/unbound-method -- apply below preserves the intercepted database owner.
    const deleteSource = MemoryIndexDatabase.prototype.deleteSource;
    const cleanup = vi
      .spyOn(MemoryIndexDatabase.prototype, "deleteSource")
      .mockImplementation(async function (this: MemoryIndexDatabase, ...params) {
        await releaseCleanup.promise;
        return await deleteSource.apply(this, params);
      });
    const release = () => releaseCleanup.resolve();
    signal.addEventListener("abort", release, { once: true });
    const partialPaths: string[][] = [];
    try {
      const results = await manager.search("alpha", {
        maxResults: 3,
        minScore: 0,
        lexicalOnly: mode === "keyword-only",
        onPartialResults: (partial) => {
          if (partial) {
            partialPaths.push(partial.map((entry) => entry.path));
          }
        },
      });

      expect(resultPaths(results)).toEqual(expectedPaths);
      expect(partialPaths.flat().every((pathname) => expectedPaths.includes(pathname))).toBe(true);
      // Successful serving cannot be explained by cleanup winning the race.
      expect(countHelpers(writer)).toEqual({ n: 201 });
      if (mode === "hybrid KNN") {
        // Large exclusion sets must use the scan, not an oversized native request.
        expect(nativeKnn).not.toHaveBeenCalled();
      }
    } finally {
      signal.removeEventListener("abort", release);
      release();
      cleanup.mockRestore();
    }
    await manager.close();
    expectHelperPruned(writer);
    expect(validIndex()).toEqual(beforeIndex);
    expect(fixture.provider.embedBatchCalls).toBe(embeddingBatches);
  },
);

it("preserves memory-sourced content whose path collides with an excluded transcript", async () => {
  const { manager, writer } = await pollutedIndex("keyword-only");
  insertKeywordFixture(writer, {
    id: "ordinary-memory-path-collision",
    path: helperPath,
    source: "memory",
    model: "fts-only",
    text: "Sourcecollision ordinary imported notes.",
  });
  expect(await manager.search("sourcecollision", { lexicalOnly: true })).toMatchObject([
    { path: helperPath, source: "memory", snippet: "Sourcecollision ordinary imported notes." },
  ]);
});

it("prunes helpers before a failing source embedding settles", async ({ signal }) => {
  const { manager, writer } = await pollutedIndex("hybrid embedding scan");
  const validChunks = () => validRows(writer, "chunks", "id, path, hash, text, embedding", "id");
  const beforeChunks = validChunks();
  await fs.writeFile(
    path.join(fixture.paths.workspace, memoryFilePath),
    "Alpha beta replacement requiring a new embedding.",
  );
  Reflect.set(manager, "dirty", true);
  const embeddingEntered = createDeferred<void>();
  const releaseEmbedding = createDeferred<void>();
  const release = () => releaseEmbedding.resolve();
  signal.addEventListener("abort", release, { once: true });
  const failure = new Error("ordinary source embedding rejected");
  const embedding = vi.fn(async () => {
    embeddingEntered.resolve();
    await releaseEmbedding.promise;
    throw failure;
  });
  fixture.provider.beforeEmbedBatch = embedding;
  const sync = manager.sync({ reason: "watch" });
  try {
    await Promise.race([
      embeddingEntered.promise,
      sync.then(() => {
        throw new Error("Sync completed before attempting the changed source embedding");
      }),
    ]);
    expect(embedding).toHaveBeenCalled();
    expectHelperPruned(writer);
    expect(validChunks()).toEqual(beforeChunks);
    release();
    await expect(sync).rejects.toThrow(failure.message);
    expect(validChunks()).toEqual(beforeChunks);
  } finally {
    signal.removeEventListener("abort", release);
    release();
    await sync.catch(() => {});
    fixture.provider.beforeEmbedBatch = null;
  }
});

it("excludes captured ownership, preserving older archives, unknown provenance and other plugins", async () => {
  const ownerId = "1bca6a96-ea9d-4238-949f-232c2e4c09a2";
  const otherId = "1868db13-ac71-459d-885d-e57ee40dde03";
  const migratedId = "a654fd85-e881-4541-a1f2-7e013bc332c9";
  const ownerScope = sessionScope(`agent:main:explicit:${ownerId}`);
  await seedTranscript(ownerId, ownerScope.sessionKey, "Alpha ordinary older archive.");
  const archiveName = await archive(ownerId, ownerScope.sessionKey);
  const preservedPaths = [
    ...[otherId, migratedId].map(sessionPath),
    `sessions/main/${archiveName}`,
  ].toSorted();
  for (const [sessionId, pluginOwnerId] of [
    [ownerId, "active-memory"],
    [otherId, "other-plugin"],
    [migratedId, "active-memory"],
  ] as const) {
    const sessionKey = `agent:main:explicit:${sessionId}`;
    await seedTranscript(sessionId, sessionKey, "Alpha ownership canary.");
    await setOwnership(sessionId, sessionKey, pluginOwnerId);
  }
  // Same-ID replacement neither revokes captured ownership nor reclassifies older archives.
  await setOwnership(ownerId, ownerScope.sessionKey);
  const currentEntry = await getSessionEntryAsync(ownerScope);
  expect(currentEntry?.sessionId).toBe(ownerId);
  expect(currentEntry?.pluginOwnerId).toBeUndefined();
  const manager = await sessionsManager();
  const writer = memoryIndexFixtureWriter(manager);
  expect(
    writer.prepare("SELECT plugin_owner_id FROM session_windows WHERE session_id = ?").get(ownerId),
  ).toEqual({ plugin_owner_id: "active-memory" });
  // Current ownership cannot retroactively classify unknown-provenance bytes.
  writer
    .prepare(
      "UPDATE session_windows SET session_entry_provenance = 0, plugin_owner_id = NULL WHERE session_id = ?",
    )
    .run(migratedId);
  await manager.sync({ reason: "index-owner-identities", force: true });
  const indexedPaths = () => sessionSources(writer);
  const preservedSources = preservedPaths.map((pathname) => ({ path: pathname }));
  expect(indexedPaths()).toEqual(preservedSources);
  // Older versions admitted this exact owner even without a recall-shaped ID/key.
  insertKeywordFixture(writer, {
    id: "historical-owner-only",
    path: sessionPath(ownerId),
    source: "sessions",
    model: "fts-only",
    text: "Alpha historical internal helper.",
  });
  expect(indexedPaths()).toHaveLength(preservedPaths.length + 1);
  expect(resultPaths(await search(manager))).toEqual(preservedPaths);
  await manager.close();
  expect(indexedPaths()).toEqual(preservedSources);
});

it("preserves an ordinary reused UUID and its unidentified index until normal reconciliation", async () => {
  const sessionId = "9cb304af-7567-4c98-8c93-a1b373f39348";
  const helperKey = "agent:main:explicit:retired:active-memory:0123456789ab";
  await seedTranscript(sessionId, helperKey, "Alpha internal recall prompt.");
  await archive(sessionId, helperKey);
  expect(await archivedSessions(sessionId)).toMatchObject([{ sessionId, sessionKey: helperKey }]);
  const ordinaryScope = sessionScope("agent:main:explicit:ordinary-reuse");
  const content = "Alpha ordinary current conversation.";
  await seedTranscript(sessionId, ordinaryScope.sessionKey, content);
  const manager = await sessionsManager(0);
  await manager.sync({ reason: "index-reused-identity", force: true });
  const writer = memoryIndexFixtureWriter(manager);
  const pathname = sessionPath(sessionId);
  const indexedSources = () => sessionSources(writer, "path, hash");
  const before = indexedSources();
  expect(before).toEqual([{ path: pathname, hash: expect.any(String) }]);
  const expected = [
    { path: pathname, source: "sessions", snippet: expect.stringContaining(content) },
  ];
  expect(await search(manager)).toMatchObject(expected);
  expect(indexedSources()).toEqual(before);
  await archive(sessionId, ordinaryScope.sessionKey);
  const ordinaryArchives = (await archivedSessions(sessionId)).filter(
    (entry) => entry.sessionKey === ordinaryScope.sessionKey,
  );
  expect(ordinaryArchives).toHaveLength(1);
  const archivePath = `sessions/main/${ordinaryArchives[0]!.archiveName}`;
  expect(
    await sessionMetadata.loadMemorySessionMetadataBatchAsync({
      ...ordinaryScope,
      sessions: [{ sessionId }],
    }),
  ).toEqual([]);
  // Older archive ownership cannot classify a live-shaped hit before stale-source cleanup.
  expect(await search(manager)).toMatchObject(expected);
  expect(indexedSources()).toEqual(before);
  await manager.sync({ reason: "cli" });
  expect(indexedSources()).toEqual([{ path: archivePath, hash: expect.any(String) }]);
  expect(await search(manager)).toMatchObject([{ ...expected[0], path: archivePath }]);
  await manager.close();
});

it.each(["live", "archive"] as const)(
  "reports failed %s identity reads instead of treating them as absent metadata",
  async (kind) => {
    const { manager } = await pollutedIndex("keyword-only");
    const failure = new Error("session identity reader unavailable");
    const method =
      kind === "live" ? "loadMemorySessionMetadataBatchAsync" : "loadArchivedSessionsAsync";
    const metadata = vi.spyOn(sessionMetadata, method).mockRejectedValueOnce(failure);
    const memoryOnly = await manager.search("alpha", { ...lexicalOptions, sources: ["memory"] });
    expect(resultPaths(memoryOnly)).toEqual([memoryFilePath]);
    await expect(search(manager)).rejects.toThrow(failure.message);
    metadata.mockRestore();
    const results = await manager.search("alpha", { ...lexicalOptions, maxResults: 3 });
    expect(resultPaths(results)).toEqual(expectedPaths);
  },
);
