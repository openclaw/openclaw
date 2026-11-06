import {
  encodeMemoryEmbedding,
  ensureMemoryIndexSchema,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it } from "vitest";
import { readMemoryIndex } from "./manager-index-read.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";

describe("published embeddings during indexing", () => {
  const { DatabaseSync } = requireNodeSqlite();
  const identity = { provider: "openai-compatible", model: "fixture", providerKey: "settings" };

  it.each([
    { name: "matching", meta: {}, vector: encodeMemoryEmbedding([1, 2, 3]), expected: true },
    { name: "provider", meta: { provider: "other" } },
    { name: "model", meta: { model: "other" } },
    { name: "settings", meta: { providerKey: "other" } },
    { name: "missing settings", meta: { providerKey: undefined } },
    { name: "wrong chunk model", meta: {}, rowModel: "other" },
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
    insert.run(
      "a",
      "hash",
      testCase.rowModel ?? metadata.model,
      vector ?? encodeMemoryEmbedding([1, 2, 3]),
    );
    insert.run("changed", "old-hash", metadata.model, encodeMemoryEmbedding([1, 2, 3]));
    const command = {
      type: "cache.read" as const,
      input: {
        providerIdentities: [identity],
        hashes: ["hash", "changed-hash"],
        published: {
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
      readMemoryIndex(db, { ...command, input: { ...command.input, published: undefined } }).value,
    ).toEqual(new Map());
  });
  it("keeps published lookup scoped, unambiguous, cache-first and cache-independent", () => {
    using db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: true,
      ftsEnabled: false,
      ftsTokenizer: "unicode61",
    });
    db.prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)").run(
      "memory_index_meta_v1",
      JSON.stringify({ ...identity, vectorDims: 3 }),
    );
    const insert = db.prepare(`INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES (?, ?, ?, 1, 1, ?, ?, 'alpha', ?, 1)`);
    const add = (id: string, path: string, source: string, hash: string, vector: number[]) =>
      insert.run(id, path, source, hash, identity.model, encodeMemoryEmbedding(vector));
    add("a", "memory/a.md", "memory", "hash", [1, 2, 3]);
    add("same", "memory/a.md", "memory", "hash", [1, 2, 3]);
    add("other-path", "memory/b.md", "memory", "hash", [3, 2, 1]);
    add("other-source", "memory/a.md", "sessions", "hash", [3, 2, 1]);
    add("foreign", "memory/b.md", "memory", "foreign", [3, 2, 1]);
    const input = {
      providerIdentities: [{ ...identity, providerKey: "primary" }, identity],
      hashes: ["hash", "foreign"],
      published: {
        chunks: ["hash", "foreign"].map((hash) => ({
          source: "memory" as const,
          path: "memory/a.md",
          hash,
        })),
        dimensions: 3,
      },
    };
    const read = () => readMemoryIndex(db, { type: "cache.read", input }).value;
    expect(read()).toEqual(new Map([["hash", [1, 2, 3]]]));
    // An identity supplied only as a nonprimary permitted alias still matches.
    expect(
      readMemoryIndex(db, {
        type: "cache.read",
        input: {
          ...input,
          providerIdentities: [input.providerIdentities[0]!],
        },
      }).value,
    ).toEqual(new Map());
    // One result map cannot choose between conflicting vectors across requested paths.
    expect(
      readMemoryIndex(db, {
        type: "cache.read",
        input: {
          ...input,
          published: {
            ...input.published,
            chunks: [
              ...input.published.chunks,
              { source: "memory", path: "memory/b.md", hash: "hash" },
            ],
          },
        },
      }).value,
    ).toEqual(new Map());
    add("conflict", "memory/a.md", "memory", "hash", [1, 2, 4]);
    expect(read()).toEqual(new Map());
    db.prepare(`INSERT INTO memory_embedding_cache
      (provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES (?, ?, ?, 'hash', ?, 3, 1)`).run(
      identity.provider,
      identity.model,
      identity.providerKey,
      encodeMemoryEmbedding([9, 8, 7]),
    );
    expect(read()).toEqual(new Map([["hash", [9, 8, 7]]]));
    expect(db.prepare("SELECT count(*) AS n FROM memory_embedding_cache").get()).toEqual({ n: 1 });
    // A disabled cache must not even query its table, including when valid rows exist.
    db.exec("DROP TABLE memory_embedding_cache");
    expect(
      readMemoryIndex(db, {
        type: "cache.read",
        input: {
          ...input,
          cacheEnabled: false,
        },
      }).value,
    ).toEqual(new Map());
    db.prepare("DELETE FROM memory_index_chunks WHERE id = 'conflict'").run();
    expect(
      readMemoryIndex(db, {
        type: "cache.read",
        input: {
          ...input,
          cacheEnabled: false,
        },
      }).value,
    ).toEqual(new Map([["hash", [1, 2, 3]]]));
  });
});
