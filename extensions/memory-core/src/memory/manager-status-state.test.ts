import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { assert, describe, expect, it, vi } from "vitest";
import { collectMemoryStatusSnapshot, resolveStatusProviderInfo } from "./manager-status-state.js";

const counts = (source: string, files: number, chunkBytes?: number) => ({
  source,
  files,
  chunks: files,
  ...(chunkBytes === undefined ? {} : { chunkBytes }),
});
const aggregate = (files: number, ...sourceCounts: ReturnType<typeof counts>[]) => ({
  files,
  chunks: files,
  sourceCounts,
});

describe("memory manager status state", () => {
  it("distinguishes retained cache payload, WAL, and reusable space without changing the database", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-storage-status-"));
    const databasePath = path.join(root, "agent.sqlite");
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE memory_embedding_cache (embedding BLOB);
        CREATE TABLE memory_index_sources (source TEXT);
        CREATE TABLE memory_index_chunks (source TEXT, text TEXT, embedding BLOB);
        CREATE TABLE other_owner (payload BLOB);
        INSERT INTO other_owner VALUES (zeroblob(1048576));
        DELETE FROM other_owner;
      `);
      const insertEmbedding = db.prepare("INSERT INTO memory_embedding_cache VALUES (?)");
      insertEmbedding.run(encodeMemoryEmbedding([1, 2]));
      insertEmbedding.run(encodeMemoryEmbedding([]));
      const before = db.prepare("SELECT total_changes() AS changes").get();
      const readStatus = () =>
        collectMemoryStatusSnapshot(db, databasePath, {
          sources: ["memory"],
          cacheEnabled: true,
          includeStorage: true,
        });
      const storage = readStatus().storage;
      assert.isDefined(storage);
      expect(storage).toMatchObject({
        embeddingCacheEntries: 2,
        embeddingCacheBytes: 16,
        databaseBytes: fs.statSync(databasePath).size,
        walBytes: fs.statSync(`${databasePath}-wal`).size,
      });
      expect(storage.walBytes).toBeGreaterThan(1048576);
      expect(storage.reusableBytes).toBeGreaterThanOrEqual(1048576);
      expect(db.prepare("SELECT total_changes() AS changes").get()).toEqual(before);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      expect(readStatus().storage?.walBytes).toBe(0);
      db.exec("VACUUM");
      expect(readStatus().storage).toMatchObject({
        reusableBytes: 0,
        embeddingCacheEntries: 2,
        embeddingCacheBytes: 16,
      });
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    [false, null, ["openai", "mock-embed", "hybrid"]],
    [true, null, ["none", undefined, "fts-only"]],
    [true, { id: "local", model: "fallback-model" }, ["local", "fallback-model", "hybrid"]],
  ] as const)("reports provider state %j %j %j", (initialized, provider, expected) => {
    const resolveConfiguredModel = vi.fn(() => "mock-embed");
    expect(
      resolveStatusProviderInfo({
        provider,
        providerInitialized: initialized,
        requestedProvider: "openai",
        resolveConfiguredModel,
      }),
    ).toEqual({ provider: expected[0], model: expected[1], searchMode: expected[2] });
    expect(resolveConfiguredModel).toHaveBeenCalledTimes(initialized ? 0 : 1);
  });

  it("counts ordinary status without evaluating stored payload columns", () => {
    using db = new DatabaseSync(":memory:");
    let payloadReads = 0;
    db.function("read_payload", { deterministic: true }, (source) => {
      payloadReads += 1;
      return `${String(source)} payload`;
    });
    db.exec(`
        CREATE TABLE memory_index_sources (source TEXT);
        CREATE TABLE memory_index_chunks (
          source TEXT,
          text TEXT GENERATED ALWAYS AS (read_payload(source)) VIRTUAL,
          embedding BLOB GENERATED ALWAYS AS (CAST(read_payload(source) AS BLOB)) VIRTUAL
        );
        CREATE INDEX sources_by_source ON memory_index_sources(source);
        CREATE INDEX chunks_by_source ON memory_index_chunks(source);
        INSERT INTO memory_index_sources VALUES ('memory'), ('sessions');
        INSERT INTO memory_index_chunks(source) VALUES ('memory'), ('sessions');
      `);
    payloadReads = 0;

    const status = collectMemoryStatusSnapshot(db, ":memory:", {
      sources: ["memory", "sessions"],
      cacheEnabled: false,
      includeStorage: false,
    });

    expect(payloadReads).toBe(0);
    expect(status.aggregate).toEqual(aggregate(2, counts("memory", 1), counts("sessions", 1)));
  });

  it("reports stored payload bytes by source without counting characters or other sources", () => {
    using db = new DatabaseSync(":memory:");
    db.exec(`
        CREATE TABLE memory_index_sources (source TEXT);
        CREATE TABLE memory_index_chunks (source TEXT, text TEXT, embedding BLOB);
        CREATE TABLE memory_embedding_cache (embedding BLOB);
        INSERT INTO memory_index_sources VALUES ('memory'), ('memory'), ('sessions');
      `);
    const insertChunk = db.prepare("INSERT INTO memory_index_chunks VALUES (?, ?, ?)");
    insertChunk.run("memory", "🦞", encodeMemoryEmbedding([1, 2]));
    insertChunk.run("memory", "abc", encodeMemoryEmbedding([]));
    insertChunk.run("sessions", "session", encodeMemoryEmbedding([3]));
    const readAggregate = (sources: Array<"memory" | "sessions">) =>
      collectMemoryStatusSnapshot(db, ":memory:", {
        cacheEnabled: false,
        includeStorage: true,
        sources,
      }).aggregate;
    expect(readAggregate(["memory", "sessions"])).toEqual(
      aggregate(3, counts("memory", 2, 23), counts("sessions", 1, 15)),
    );
    expect(readAggregate(["memory"])).toEqual(aggregate(2, counts("memory", 2, 23)));
    db.exec("DELETE FROM memory_index_sources; DELETE FROM memory_index_chunks;");
    expect(readAggregate(["memory"])).toEqual(aggregate(0, counts("memory", 0, 0)));
  });
});
