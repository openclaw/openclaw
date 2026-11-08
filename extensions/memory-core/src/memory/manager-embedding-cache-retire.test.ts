import type { SQLInputValue } from "node:sqlite";
import { resolveEmbeddingInputFormatVersion } from "openclaw/plugin-sdk/memory-core-host-engine-indexing";
import {
  encodeMemoryEmbedding,
  ensureMemoryIndexSchema,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import { retirePublishedMemoryEmbeddingCacheRows } from "./manager-embedding-cache-retire.js";

/** Rows per cache.retire page, as in manager-embedding-cache-retire.ts. */
const RETIRE_PAGE = 256;

describe("published embedding cache retirement", () => {
  const { DatabaseSync } = requireNodeSqlite();
  type Database = InstanceType<typeof DatabaseSync>;
  const identity = { provider: "local", model: "fixture", providerKey: "key" };
  const vector = (seed: number) => [seed, seed + 0.5];

  function open(meta: Record<string, unknown> = {}): Database {
    const db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: true,
      ftsEnabled: false,
      ftsTokenizer: "unicode61",
    });
    db.prepare("INSERT INTO memory_index_meta (key, value) VALUES ('memory_index_meta_v1', ?)").run(
      JSON.stringify({
        provider: identity.provider,
        model: identity.model,
        providerKey: identity.providerKey,
        embeddingInputFormatVersion: resolveEmbeddingInputFormatVersion(identity.model),
        vectorDims: 2,
        ...meta,
      }),
    );
    return db;
  }

  let chunkId = 0;
  function chunk(
    db: Database,
    hash: string,
    embedding: number[],
    options: { source?: string; model?: string; path?: string } = {},
  ) {
    chunkId += 1;
    db.prepare(
      `INSERT INTO memory_index_chunks
        (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
       VALUES (?, ?, ?, 1, 1, ?, ?, 'text', ?, 100)`,
    ).run(
      `chunk-${chunkId}`,
      options.path ?? `memory/${chunkId}.md`,
      options.source ?? "memory",
      hash,
      options.model ?? identity.model,
      encodeMemoryEmbedding(embedding),
    );
  }

  function cache(
    db: Database,
    hash: string,
    embedding: number[],
    updatedAt = 50,
    owner: { provider: string; model: string; providerKey: string } = identity,
  ) {
    db.prepare(
      `INSERT INTO memory_embedding_cache
        (provider, model, provider_key, hash, embedding, dims, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      owner.provider,
      owner.model,
      owner.providerKey,
      hash,
      encodeMemoryEmbedding(embedding),
      embedding.length,
      updatedAt,
    );
  }

  const cachedHashes = (db: Database) =>
    db
      .prepare("SELECT provider_key AS key, hash FROM memory_embedding_cache ORDER BY key, hash")
      .all()
      .map((row) => `${String(row.key)}:${String(row.hash)}`);

  it("retires only rows whose exact vector every published chunk of the hash holds", () => {
    using db = open();
    chunk(db, "same", vector(1));
    chunk(db, "same", vector(1), { source: "sessions" });
    cache(db, "same", vector(1));
    // A provider that is not bit-deterministic: the published variants disagree.
    chunk(db, "ambiguous", vector(2));
    chunk(db, "ambiguous", vector(2.0001));
    cache(db, "ambiguous", vector(2));
    // The cache row differs from the only published variant.
    chunk(db, "different", vector(3));
    cache(db, "different", vector(3.0001));
    // A retry's unpublished vector.
    cache(db, "unpublished", vector(4));
    // Session-only hashes have no memory-file read-through.
    chunk(db, "session", vector(5), { source: "sessions" });
    cache(db, "session", vector(5));
    // Chunks from another model cannot serve this identity.
    chunk(db, "other-model", vector(6), { model: "other" });
    cache(db, "other-model", vector(6));
    // Rows written before this run, and rows of another identity, are out of scope.
    chunk(db, "older", vector(7));
    cache(db, "older", vector(7), 49);
    chunk(db, "alias", vector(8));
    cache(db, "alias", vector(8), 50, { ...identity, providerKey: "alias" });
    // A differing session variant still makes the hash ambiguous.
    chunk(db, "mixed", vector(9));
    chunk(db, "mixed", vector(9.5), { source: "sessions" });
    cache(db, "mixed", vector(9));
    // Vectors of another size are not the published vector space.
    chunk(db, "short", [10]);
    cache(db, "short", [10]);

    expect(retirePublishedMemoryEmbeddingCacheRows(db, { identity, writtenSince: 50 })).toEqual({
      removed: 1,
    });
    expect(cachedHashes(db)).toEqual([
      "alias:alias",
      "key:ambiguous",
      "key:different",
      "key:mixed",
      "key:older",
      "key:other-model",
      "key:session",
      "key:short",
      "key:unpublished",
    ]);
  });

  it.each([
    ["another provider key", { providerKey: "other" }],
    ["no provider key", { providerKey: undefined }],
    ["no vector dimensions", { vectorDims: undefined }],
    ["different vector dimensions", { vectorDims: 3 }],
    ["fts-only", { model: "fts-only" }],
    ["a stale input format", { embeddingInputFormatVersion: 99 }],
  ])("retires nothing when the published index has %s", (_name, meta) => {
    using db = open(meta);
    chunk(db, "same", vector(1));
    cache(db, "same", vector(1));
    expect(retirePublishedMemoryEmbeddingCacheRows(db, { identity, writtenSince: 0 })).toEqual({
      removed: 0,
    });
    expect(cachedHashes(db)).toEqual(["key:same"]);
  });

  it.each(["{not json", null])("retires nothing for unreadable metadata %s", (value) => {
    using db = open();
    if (value === null) {
      db.exec("DELETE FROM memory_index_meta");
    } else {
      db.prepare("UPDATE memory_index_meta SET value = ?").run(value);
    }
    chunk(db, "same", vector(1));
    cache(db, "same", vector(1));
    expect(retirePublishedMemoryEmbeddingCacheRows(db, { identity, writtenSince: 0 })).toEqual({
      removed: 0,
    });
    expect(cachedHashes(db)).toEqual(["key:same"]);
  });

  it("bounds each call to one page and resumes after its cursor", () => {
    using db = open();
    const total = RETIRE_PAGE + 3;
    for (let i = 0; i < total; i += 1) {
      const hash = `h${String(i).padStart(4, "0")}`;
      chunk(db, hash, vector(i));
      // Odd rows keep a different vector, so pages advance past retained rows.
      cache(db, hash, i % 2 === 0 ? vector(i) : vector(i + 0.25), 60 + (i % 7));
    }
    const first = retirePublishedMemoryEmbeddingCacheRows(db, { identity, writtenSince: 60 });
    expect(first.next).toBeDefined();
    expect(first.removed).toBeLessThanOrEqual(RETIRE_PAGE);
    // Every later page must walk one updated_at range instead of sorting what remains.
    const plans: string[] = [];
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (sql.startsWith("select") && sql.includes("order by")) {
        const iterate = statement.iterate.bind(statement);
        statement.iterate = ((...params: SQLInputValue[]) => {
          const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
          plans.push(plan.map((row) => String(row.detail)).join("; "));
          return iterate(...params);
        }) as typeof statement.iterate;
      }
      return statement;
    });
    const second = retirePublishedMemoryEmbeddingCacheRows(db, {
      identity,
      writtenSince: 60,
      after: first.next,
    });
    spy.mockRestore();
    expect(plans).toHaveLength(1);
    // A range search starting at the cursor: a scan could revisit earlier pages.
    expect(plans[0]).toContain(
      "SEARCH memory_embedding_cache USING INDEX idx_memory_embedding_cache_updated_at (updated_at>?",
    );
    // Only ties within one updated_at value may sort, not the remaining range.
    expect(plans[0]).not.toMatch(/MULTI-INDEX OR|TEMP B-TREE FOR ORDER BY/);
    expect(second.next).toBeUndefined();
    expect(first.removed + second.removed).toBe(Math.ceil(total / 2));
    expect(cachedHashes(db)).toHaveLength(Math.floor(total / 2));
  });
});
