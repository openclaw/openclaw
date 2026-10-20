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
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./manager-index.test-support.js";
import * as knn from "./manager-search-knn.js";
import { insertKeywordFixture } from "./manager-search.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

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

describe("Active Memory historical search eligibility", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  afterEach(() => vi.restoreAllMocks());

  async function pollutedIndex(mode: RetrievalMode) {
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    const storePath = path.join(sessionsDir, "sessions.json");
    const archivedHelperKey = "agent:main:explicit:laptop:active-memory:0123456789ab";
    for (const session of [
      { sessionId: "ordinary-conversation", sessionKey: "agent:main:explicit:ordinary" },
      {
        sessionId: liveHelperId,
        sessionKey: "agent:main:explicit:phone:active-memory:abcdef123456",
      },
      { sessionId: archivedHelperId, sessionKey: archivedHelperKey },
    ]) {
      await fixture.seedSessionTranscript({
        ...session,
        messages: [{ role: "user", timestamp: Date.now(), content: "Alpha beta ordinary fact." }],
      });
    }
    await expect(
      deleteSessionEntry({
        agentId: "main",
        sessionKey: archivedHelperKey,
        storePath,
        expectedSessionId: archivedHelperId,
        archiveTranscript: true,
      }),
    ).resolves.toBe(true);
    const archivedHelperName = (await fs.readdir(sessionsDir)).find((name) =>
      name.startsWith(`${archivedHelperId}.jsonl.deleted.`),
    );
    if (!archivedHelperName) {
      throw new Error("The real helper deletion did not produce an archive");
    }
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
    const cfg = fixture.createConfig({
      provider: mode === "keyword-only" ? "none" : "openai",
      sources: ["memory", "sessions"],
      rememberAcrossConversations: true,
      vectorEnabled: mode === "hybrid KNN",
      minScore: 0,
    });
    // CLI readers do not start background transcript listeners or catch-up timers.
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
    // Historical data intentionally bypasses current admission. More than the 200-row
    // candidate window ensures a filter after LIMIT cannot hide legitimate answers.
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
    expect(
      writer
        .prepare(
          "SELECT COUNT(*) AS n FROM memory_index_chunks WHERE path = ? AND source = 'sessions'",
        )
        .get(helperPath),
    ).toEqual({ n: 201 });
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
      const validChunks = () =>
        writer
          .prepare(
            "SELECT id, path, hash, embedding, updated_at FROM memory_index_chunks WHERE path IN (?, ?, ?) ORDER BY id",
          )
          .all(...expectedPaths);
      const validSources = () =>
        writer
          .prepare(
            "SELECT path, source, hash, mtime, size FROM memory_index_sources WHERE path IN (?, ?, ?) ORDER BY path",
          )
          .all(...expectedPaths);
      const beforeChunks = validChunks();
      const beforeSources = validSources();
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

        expect(results.map((entry) => entry.path).toSorted()).toEqual(expectedPaths);
        for (const paths of partialPaths) {
          expect(paths.every((pathname) => expectedPaths.includes(pathname))).toBe(true);
        }
        // Successful serving cannot be explained by cleanup winning the race.
        expect(
          writer
            .prepare(
              "SELECT COUNT(*) AS n FROM memory_index_chunks WHERE path = ? AND source = 'sessions'",
            )
            .get(helperPath),
        ).toEqual({ n: 201 });
        if (mode === "hybrid KNN") {
          // Recovery reuses the embedding scan so large exclusion sets do not
          // become an oversized native-subprocess request.
          expect(nativeKnn).not.toHaveBeenCalled();
        }
      } finally {
        signal.removeEventListener("abort", release);
        release();
        cleanup.mockRestore();
      }
      await manager.close();
      expect(
        writer
          .prepare("SELECT path FROM memory_index_sources WHERE path = ? AND source = 'sessions'")
          .all(helperPath),
      ).toEqual([]);
      expect(
        writer
          .prepare("SELECT id FROM memory_index_chunks WHERE path = ? AND source = 'sessions'")
          .all(helperPath),
      ).toEqual([]);
      expect(validChunks()).toEqual(beforeChunks);
      expect(validSources()).toEqual(beforeSources);
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

  it("prunes historical helpers during ordinary sync even when another source cannot embed", async ({
    signal,
  }) => {
    const { manager, writer } = await pollutedIndex("hybrid embedding scan");
    const validChunks = () =>
      writer
        .prepare(
          "SELECT id, path, hash, text, embedding FROM memory_index_chunks WHERE path IN (?, ?, ?) ORDER BY id",
        )
        .all(...expectedPaths);
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
      expect(
        writer
          .prepare("SELECT path FROM memory_index_sources WHERE path = ? AND source = 'sessions'")
          .all(helperPath),
      ).toEqual([]);
      expect(
        writer
          .prepare("SELECT id FROM memory_index_chunks WHERE path = ? AND source = 'sessions'")
          .all(helperPath),
      ).toEqual([]);
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

  it("uses captured plugin ownership while preserving ordinary archives, unknown provenance, and other plugins", async () => {
    const ownerId = "1bca6a96-ea9d-4238-949f-232c2e4c09a2";
    const otherId = "1868db13-ac71-459d-885d-e57ee40dde03";
    const migratedId = "a654fd85-e881-4541-a1f2-7e013bc332c9";
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    const storePath = path.join(sessionsDir, "sessions.json");
    const ownerScope = {
      agentId: "main",
      sessionKey: `agent:main:explicit:${ownerId}`,
      storePath,
    };
    await fixture.seedSessionTranscript({
      sessionId: ownerId,
      sessionKey: ownerScope.sessionKey,
      messages: [{ role: "user", timestamp: Date.now(), content: "Alpha ordinary older archive." }],
    });
    await expect(
      deleteSessionEntry({
        ...ownerScope,
        expectedSessionId: ownerId,
        archiveTranscript: true,
      }),
    ).resolves.toBe(true);
    const archiveName = (await fs.readdir(sessionsDir)).find((name) =>
      name.startsWith(`${ownerId}.jsonl.deleted.`),
    );
    if (!archiveName) {
      throw new Error("The ordinary conversation deletion did not produce an archive");
    }
    const preservedPaths = [
      ...[otherId, migratedId].map((sessionId) => `sessions/main/${sessionId}.jsonl`),
      `sessions/main/${archiveName}`,
    ].toSorted();
    for (const { sessionId, pluginOwnerId } of [
      { sessionId: ownerId, pluginOwnerId: "active-memory" },
      { sessionId: otherId, pluginOwnerId: "other-plugin" },
      { sessionId: migratedId, pluginOwnerId: "active-memory" },
    ]) {
      const sessionKey = `agent:main:explicit:${sessionId}`;
      await fixture.seedSessionTranscript({
        sessionId,
        sessionKey,
        messages: [{ role: "user", timestamp: Date.now(), content: "Alpha ownership canary." }],
      });
      await upsertSessionEntry({
        agentId: "main",
        sessionKey,
        storePath,
        entry: { sessionId, updatedAt: Date.now(), pluginOwnerId },
      });
    }
    // Same-ID metadata replacement can omit the owner without revoking the
    // window's captured ownership. It must not affect the older ordinary archive.
    await upsertSessionEntry({
      ...ownerScope,
      entry: { sessionId: ownerId, updatedAt: Date.now() },
    });
    const currentEntry = await getSessionEntryAsync(ownerScope);
    expect(currentEntry?.sessionId).toBe(ownerId);
    expect(currentEntry?.pluginOwnerId).toBeUndefined();
    const manager = await fixture.getFreshManager(
      fixture.createConfig({
        provider: "none",
        sources: ["sessions"],
        rememberAcrossConversations: true,
        vectorEnabled: false,
      }),
      "cli",
    );
    const writer = memoryIndexFixtureWriter(manager);
    expect(
      writer
        .prepare("SELECT plugin_owner_id FROM session_windows WHERE session_id = ?")
        .get(ownerId),
    ).toEqual({ plugin_owner_id: "active-memory" });
    // Migrated transcripts retain unknown provenance even while current metadata
    // names a plugin owner. Same-ID updates cannot retroactively classify their bytes.
    writer
      .prepare(
        "UPDATE session_windows SET session_entry_provenance = 0, plugin_owner_id = NULL WHERE session_id = ?",
      )
      .run(migratedId);
    await manager.sync({ reason: "index-owner-identities", force: true });
    const indexedPaths = () =>
      writer
        .prepare("SELECT path FROM memory_index_sources WHERE source = 'sessions' ORDER BY path")
        .all();
    expect(indexedPaths()).toEqual(preservedPaths.map((pathname) => ({ path: pathname })));
    // Older versions admitted this exact owner even without a recall-shaped ID/key.
    insertKeywordFixture(writer, {
      id: "historical-owner-only",
      path: `sessions/main/${ownerId}.jsonl`,
      source: "sessions",
      model: "fts-only",
      text: "Alpha historical internal helper.",
    });
    expect(indexedPaths()).toHaveLength(preservedPaths.length + 1);
    const results = await manager.search("alpha", { lexicalOnly: true });
    expect(results.map((entry) => entry.path).toSorted()).toEqual(preservedPaths);
    await manager.close();
    expect(indexedPaths()).toEqual(preservedPaths.map((pathname) => ({ path: pathname })));
  });

  it("preserves an ordinary reused UUID and its unidentified index until normal reconciliation", async () => {
    const sessionId = "9cb304af-7567-4c98-8c93-a1b373f39348";
    const helperKey = "agent:main:explicit:retired:active-memory:0123456789ab";
    const storePath = path.join(resolveSessionTranscriptsDirForAgent("main"), "sessions.json");
    await fixture.seedSessionTranscript({
      sessionId,
      sessionKey: helperKey,
      messages: [{ role: "user", timestamp: Date.now(), content: "Alpha internal recall prompt." }],
    });
    await expect(
      deleteSessionEntry({
        agentId: "main",
        sessionKey: helperKey,
        storePath,
        expectedSessionId: sessionId,
        archiveTranscript: true,
      }),
    ).resolves.toBe(true);
    expect(
      await sessionMetadata.loadArchivedSessionsAsync({
        agentId: "main",
        storePath,
        sessionIds: [sessionId],
      }),
    ).toMatchObject([{ sessionId, sessionKey: helperKey }]);
    const ordinaryScope = {
      agentId: "main",
      sessionKey: "agent:main:explicit:ordinary-reuse",
      storePath,
    };
    await fixture.seedSessionTranscript({
      sessionId,
      sessionKey: ordinaryScope.sessionKey,
      messages: [
        { role: "user", timestamp: Date.now(), content: "Alpha ordinary current conversation." },
      ],
    });
    // CLI managers leave transcript notifications to the next explicit sync.
    const manager = await fixture.getFreshManager(
      fixture.createConfig({
        provider: "none",
        sources: ["sessions"],
        rememberAcrossConversations: true,
        vectorEnabled: false,
        minScore: 0,
      }),
      "cli",
    );
    await manager.sync({ reason: "index-reused-identity", force: true });
    const writer = memoryIndexFixtureWriter(manager);
    const pathname = `sessions/main/${sessionId}.jsonl`;
    const indexedSources = () =>
      writer
        .prepare(
          "SELECT path, hash FROM memory_index_sources WHERE source = 'sessions' ORDER BY path",
        )
        .all();
    const before = indexedSources();
    expect(before).toEqual([{ path: pathname, hash: expect.any(String) }]);
    const expected = [
      {
        path: pathname,
        source: "sessions",
        snippet: expect.stringContaining("Alpha ordinary current conversation."),
      },
    ];
    expect(await manager.search("alpha", { lexicalOnly: true })).toMatchObject(expected);
    expect(indexedSources()).toEqual(before);
    await expect(
      deleteSessionEntry({
        ...ordinaryScope,
        expectedSessionId: sessionId,
        archiveTranscript: true,
      }),
    ).resolves.toBe(true);
    const ordinaryArchives = (
      await sessionMetadata.loadArchivedSessionsAsync({
        agentId: "main",
        storePath,
        sessionIds: [sessionId],
      })
    ).filter((archive) => archive.sessionKey === ordinaryScope.sessionKey);
    expect(ordinaryArchives).toHaveLength(1);
    const archivePath = `sessions/main/${ordinaryArchives[0]!.archiveName}`;
    expect(
      await sessionMetadata.loadMemorySessionMetadataBatchAsync({
        agentId: "main",
        storePath,
        sessions: [{ sessionId }],
      }),
    ).toEqual([]);
    // An older archive cannot identify the generation behind a live-shaped hit.
    // Missing current metadata keeps that hit eligible until normal stale-source cleanup.
    expect(await manager.search("alpha", { lexicalOnly: true })).toMatchObject(expected);
    expect(indexedSources()).toEqual(before);
    await manager.sync({ reason: "cli" });
    expect(indexedSources()).toEqual([{ path: archivePath, hash: expect.any(String) }]);
    expect(await manager.search("alpha", { lexicalOnly: true })).toMatchObject([
      {
        path: archivePath,
        source: "sessions",
        snippet: expect.stringContaining("Alpha ordinary current conversation."),
      },
    ]);
    await manager.close();
  });

  it.each(["live", "archive"] as const)(
    "reports failed %s identity reads instead of treating them as absent metadata",
    async (kind) => {
      const { manager } = await pollutedIndex("keyword-only");
      const failure = new Error("session identity reader unavailable");
      const metadata =
        kind === "live"
          ? vi
              .spyOn(sessionMetadata, "loadMemorySessionMetadataBatchAsync")
              .mockRejectedValueOnce(failure)
          : vi.spyOn(sessionMetadata, "loadArchivedSessionsAsync").mockRejectedValueOnce(failure);
      expect(
        (await manager.search("alpha", { lexicalOnly: true, sources: ["memory"] })).map(
          (entry) => entry.path,
        ),
      ).toEqual([memoryFilePath]);
      await expect(manager.search("alpha", { lexicalOnly: true })).rejects.toThrow(failure.message);
      metadata.mockRestore();
      expect(
        (await manager.search("alpha", { lexicalOnly: true, maxResults: 3 }))
          .map((entry) => entry.path)
          .toSorted(),
      ).toEqual(expectedPaths);
    },
  );
});
