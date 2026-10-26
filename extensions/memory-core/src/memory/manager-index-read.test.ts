import {
  encodeMemoryEmbedding,
  ensureMemoryIndexSchema,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it } from "vitest";
import { readMemoryIndex } from "./manager-index-read.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";

describe("published embeddings during rebuild", () => {
  const { DatabaseSync } = requireNodeSqlite();
  const identity = { provider: "openai-compatible", model: "fixture", providerKey: "settings" };

  it.each([
    { name: "matching", meta: {}, vector: encodeMemoryEmbedding([1, 2, 3]), expected: true },
    { name: "provider", meta: { provider: "other" } },
    { name: "model", meta: { model: "other" } },
    { name: "settings", meta: { providerKey: "other" } },
    { name: "input format", meta: { embeddingInputFormatVersion: 1 } },
    { name: "dimensions", meta: { vectorDims: 2 }, vector: encodeMemoryEmbedding([1, 2]) },
    { name: "wrong vector length", meta: {}, vector: encodeMemoryEmbedding([1, 2]) },
    { name: "missing dimensions", meta: { vectorDims: undefined } },
    { name: "fractional dimensions", meta: { vectorDims: 3.5 } },
    { name: "invalid JSON metadata", meta: {}, serializedMeta: "{" },
    { name: "non-object metadata", meta: {}, serializedMeta: "null" },
    { name: "fts only", meta: { model: "fts-only", provider: "none" } },
    { name: "empty vector", meta: {}, vector: new Uint8Array() },
    { name: "malformed vector", meta: {}, vector: new Uint8Array(7) },
    {
      name: "nonfinite vector",
      meta: {},
      vector: new Uint8Array(new Float64Array([Number.NaN, 0, 0]).buffer),
    },
  ])("reuses only compatible chunk vectors: $name", (testCase) => {
    const { meta, vector, expected, serializedMeta } = testCase;
    using db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: true,
      ftsEnabled: false,
      ftsTokenizer: "unicode61",
    });
    const metadata: MemoryIndexMeta = {
      ...identity,
      vectorDims: 3,
      chunkTokens: 400,
      chunkOverlap: 80,
      ...meta,
    };
    db.prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)").run(
      "memory_index_meta_v1",
      serializedMeta ?? JSON.stringify(metadata),
    );
    const insert = db.prepare(`INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES (?, 'memory/a.md', 'memory', 1, 1, ?, ?, 'alpha', ?, 1)`);
    insert.run("a", "hash", metadata.model, vector ?? encodeMemoryEmbedding([1, 2, 3]));
    insert.run("changed", "old-hash", metadata.model, encodeMemoryEmbedding([1, 2, 3]));
    const command = {
      type: "cache.read" as const,
      input: {
        providerIdentities: [identity],
        hashes: ["hash", "changed-hash"],
        rebuild: {
          chunks: ["hash", "changed-hash"].map((hash) => ({
            source: "memory" as const,
            path: "memory/a.md",
            hash,
          })),
          dimensions: 3,
        },
      },
    };
    expect(readMemoryIndex(db, command).value).toEqual(
      new Map(expected ? [["hash", [1, 2, 3]]] : []),
    );
    // Ordinary cache reads keep their cache-only contract.
    expect(
      readMemoryIndex(db, { ...command, input: { ...command.input, rebuild: undefined } }).value,
    ).toEqual(new Map());
  });
});
