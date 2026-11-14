import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getEnvironmentData, threadId } from "node:worker_threads";
import {
  openEngineStore,
  withEngineStoreAdmission,
  type EngineConnection,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { resolveEmbeddingInputFormatVersion } from "openclaw/plugin-sdk/memory-core-host-engine-indexing";
import {
  encodeMemoryEmbedding,
  isPostgresSqlConnection,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  runSqliteImmediateTransactionSync,
  type SynchronousSqliteCallback,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  retirePublishedMemoryEmbeddingCacheRows,
  type MemoryEmbeddingCacheRetirement,
} from "./manager-embedding-cache-retire.js";

/** Rows per cache.retire page, as in manager-embedding-cache-retire.ts. */
const RETIRE_PAGE = 256;

const configured: unknown = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const identity = { provider: "local", model: "fixture", providerKey: "key" };
const canonicalAgentSql = fs.readFileSync(
  new URL("../../../../src/state/postgres-schema.generated/agent.postgres.sql", import.meta.url),
  "utf8",
);
const retireSchema = [
  /CREATE TABLE "memory_embedding_cache" \([\s\S]*?\n\);/,
  /CREATE INDEX "idx_memory_embedding_cache_updated_at"[^;]+;/,
  /CREATE TABLE "memory_index_chunks" \([\s\S]*?\n\);/,
  /CREATE TABLE "memory_index_meta" \([\s\S]*?\n\);/,
].map((pattern) => canonicalAgentSql.match(pattern)?.[0]);
if (retireSchema.some((sql) => !sql)) {
  throw new Error("Canonical embedding-cache retirement PostgreSQL schema is missing");
}

describe.skipIf(!connection)("PostgreSQL memory embedding cache retirement", () => {
  const dirs = useAutoCleanupTempDirTracker(afterAll);
  const vector = (seed: number) => [seed, seed + 0.5];
  let anchor: DatabaseSync;
  let namespace: string;
  let database: EngineConnection;
  let chunkId = 0;
  function db() {
    if (!isPostgresSqlConnection(database)) {
      throw new Error("Expected PostgreSQL retirement fixture");
    }
    return database;
  }
  const write = <T>(operation: SynchronousSqliteCallback<T>) =>
    withEngineStoreAdmission(() => runSqliteImmediateTransactionSync(database, operation));
  const retire = (input: MemoryEmbeddingCacheRetirement) =>
    write(() => retirePublishedMemoryEmbeddingCacheRows(database, input));
  function publishMeta(meta: Record<string, unknown> = {}) {
    write(() =>
      db()
        .prepare("INSERT INTO memory_index_meta (key, value) VALUES ('memory_index_meta_v1', ?)")
        .run(
          JSON.stringify({
            ...identity,
            embeddingInputFormatVersion: resolveEmbeddingInputFormatVersion(identity.model),
            vectorDims: 2,
            ...meta,
          }),
        ),
    );
  }
  function chunk(
    hash: string,
    embedding: number[],
    options: { source?: string; model?: string } = {},
  ) {
    chunkId += 1;
    db()
      .prepare(
        `INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
         VALUES (?, ?, ?, 1, 1, ?, ?, 'text', ?, 100)`,
      )
      .run(
        `chunk-${chunkId}`,
        `memory/${chunkId}.md`,
        options.source ?? "memory",
        hash,
        options.model ?? identity.model,
        encodeMemoryEmbedding(embedding),
      );
  }
  function cache(
    hash: string,
    embedding: number[],
    updatedAt = 50,
    owner: typeof identity = identity,
  ) {
    db()
      .prepare(
        `INSERT INTO memory_embedding_cache
          (provider, model, provider_key, hash, embedding, dims, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        owner.provider,
        owner.model,
        owner.providerKey,
        hash,
        encodeMemoryEmbedding(embedding),
        embedding.length,
        updatedAt,
      );
  }
  const cachedHashes = () =>
    withEngineStoreAdmission(() =>
      db()
        .prepare("SELECT provider_key AS key, hash FROM memory_embedding_cache ORDER BY key, hash")
        .all()
        .map((row) => `${String(row.key)}:${String(row.hash)}`),
    );

  beforeAll(() => {
    expect(threadId, "The suite retains one in-process admission descriptor").toBe(0);
    const { DatabaseSync } = requireNodeSqlite();
    anchor = new DatabaseSync(path.join(dirs.make("pg-memory-retire-"), "anchor.sqlite"));
    database = withEngineStoreAdmission(() =>
      openEngineStore({
        anchor,
        schema: {
          id: "memory_retire",
          version: 1,
          sqlite: "",
          postgres: retireSchema.join("\n"),
        },
        input: { connection: connection!, schemaPrefix: "memory_retire_test" },
        openSqlite: () => {
          throw new Error("Unexpected SQLite retirement fixture");
        },
        prepareAnchor: () => {},
        inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: false }),
      }),
    );
    namespace = withEngineStoreAdmission(() =>
      String(db().prepare("SELECT current_schema() AS name").get()?.name),
    );
  });
  beforeEach(() =>
    write(() =>
      db().exec(
        "DELETE FROM memory_embedding_cache; DELETE FROM memory_index_chunks; DELETE FROM memory_index_meta",
      ),
    ),
  );
  afterAll(() => {
    withEngineStoreAdmission(() => {
      try {
        if (database?.isOpen) {
          db().exec(`DROP SCHEMA "${namespace}" CASCADE`);
        }
      } finally {
        database?.close();
        anchor?.close();
      }
    });
  });

  it("retires only rows whose exact vector every published chunk of the hash holds", () => {
    publishMeta();
    write(() => {
      chunk("same", vector(1));
      chunk("same", vector(1), { source: "sessions" });
      cache("same", vector(1));
      // A provider that is not bit-deterministic: the published variants disagree.
      chunk("ambiguous", vector(2));
      chunk("ambiguous", vector(2.0001));
      cache("ambiguous", vector(2));
      // The cache row differs from the only published variant.
      chunk("different", vector(3));
      cache("different", vector(3.0001));
      cache("unpublished", vector(4));
      // Session-only hashes have no memory-file read-through.
      chunk("session", vector(5), { source: "sessions" });
      cache("session", vector(5));
      chunk("other-model", vector(6), { model: "other" });
      cache("other-model", vector(6));
      // Rows written before this run, and rows of another identity, are out of scope.
      chunk("older", vector(7));
      cache("older", vector(7), 49);
      chunk("alias", vector(8));
      cache("alias", vector(8), 50, { ...identity, providerKey: "alias" });
    });
    expect(retire({ identity, writtenSince: 50 })).toEqual({ removed: 1 });
    expect(cachedHashes()).toEqual([
      "alias:alias",
      "key:ambiguous",
      "key:different",
      "key:older",
      "key:other-model",
      "key:session",
      "key:unpublished",
    ]);
  });

  it("retires existing rows only before the rebuild fence", () => {
    publishMeta();
    write(() => {
      chunk("existing", vector(1));
      cache("existing", vector(1), 10);
      chunk("existing-different", vector(2));
      cache("existing-different", vector(2.5), 10);
      cache("existing-unpublished", vector(3), 10);
      chunk("during", vector(4));
      cache("during", vector(4), 50);
    });
    expect(retire({ identity, writtenBefore: 50 })).toEqual({ removed: 1 });
    expect(cachedHashes()).toEqual([
      "key:during",
      "key:existing-different",
      "key:existing-unpublished",
    ]);
  });

  it("retires nothing when the published index has another provider key", () => {
    publishMeta({ providerKey: "other" });
    write(() => {
      chunk("same", vector(1));
      cache("same", vector(1));
    });
    expect(retire({ identity, writtenSince: 0 })).toEqual({ removed: 0 });
    expect(cachedHashes()).toEqual(["key:same"]);
  });

  it("bounds each call to one page and resumes after its cursor", () => {
    publishMeta();
    const total = RETIRE_PAGE + 3;
    write(() => {
      for (let i = 0; i < total; i += 1) {
        const hash = `h${String(i).padStart(4, "0")}`;
        chunk(hash, vector(i));
        // Odd rows keep a different vector, so pages advance past retained rows.
        cache(hash, i % 2 === 0 ? vector(i) : vector(i + 0.25), 60 + (i % 7));
      }
    });
    const first = retire({ identity, writtenSince: 60 });
    expect(first.next).toBeDefined();
    expect(first.removed).toBeLessThanOrEqual(RETIRE_PAGE);
    const second = retire({ identity, writtenSince: 60, after: first.next });
    expect(second.next).toBeUndefined();
    expect(first.removed + second.removed).toBe(Math.ceil(total / 2));
    expect(cachedHashes()).toHaveLength(Math.floor(total / 2));
  });
});
