import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureMemorySessionTombstones,
  recordMemorySessionTombstonesInDatabase,
} from "../memory-session-tombstones.js";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import {
  memoryEmbeddingCacheBatches,
  memoryPublicationBatches,
} from "./manager-publication-transfer.js";
import type { MemorySourceIndexReplacement } from "./manager-source-index-kernel.js";

// Real worker staging and settlement; synthetic private DB only.
describe("rebuild staged transfer boundary", () => {
  const roots = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));
  it("discards staged cache/source work, replays, preserves empty rows and filters tombstones", async () => {
    const file = path.join(roots.make("memory-rebuild-transfer-"), "index.sqlite");
    // Seed the offline fixture before its first worker admission.
    const fixture = new DatabaseSync(file);
    try {
      ensureMemoryIndexSchema({ db: fixture, cacheEnabled: true, ftsEnabled: true });
      ensureMemorySessionTombstones(fixture);
      recordMemorySessionTombstonesInDatabase(fixture, {
        agentId: "main",
        sessionIds: ["forgotten"],
        createdAt: 1,
      });
    } finally {
      fixture.close();
    }
    const owner = await MemoryIndexDatabase.openShadow(file, false);
    try {
      await owner.admitSchema({ cacheEnabled: true, ftsEnabled: true });
      expect(
        await owner.read(
          { type: "session.current", input: { agentId: "main", sessionId: "forgotten" } },
          () => undefined,
        ),
      ).toBe("forgotten");
      const vector = Array.from({ length: 4096 }, (_, i) => ((i % 31) - 15) / 37);
      vector.splice(0, 4, -0, Number.MIN_VALUE, Number.MAX_VALUE, 1 + Number.EPSILON);
      const entries = Array.from({ length: 40 }, (_, i) => ({
        hash: "hash-" + i,
        embedding: vector,
      }));
      const mutation = {
        kind: "upsert" as const,
        header: {
          agentId: "main",
          provider: { id: "synthetic", model: "boundary" },
          providerKey: "key",
        },
        entries: [
          ...entries,
          { hash: "empty", embedding: [] },
          { hash: "forgotten", embedding: vector, sessionId: "forgotten" },
        ],
      };
      let batches = 0;
      let largestBatch = 0;
      for (const batch of memoryEmbeddingCacheBatches(mutation.entries)) {
        batches++;
        largestBatch = Math.max(largestBatch, serialize(batch).byteLength);
      }
      expect(batches).toBeGreaterThan(1);
      expect(largestBatch).toBeLessThanOrEqual(512 * 1024);
      let checks = 0;
      expect(
        await owner.mutateEmbeddingCache(
          mutation,
          () => undefined,
          () => ++checks === 1,
        ),
      ).toBeUndefined();
      expect(owner.db.prepare("SELECT count(*) AS n FROM memory_embedding_cache").get()).toEqual({
        n: 0,
      });
      expect(
        await owner.mutateEmbeddingCache(
          mutation,
          () => undefined,
          () => true,
        ),
      ).toBe(true);
      const rows = owner.db
        .prepare("SELECT hash, embedding, dims FROM memory_embedding_cache ORDER BY hash")
        .all();
      expect(rows).toHaveLength(41);
      expect(rows.some((row) => row.hash === "forgotten")).toBe(false);
      expect(rows.find((row) => row.hash === "empty")).toMatchObject({ dims: 0 });
      const expected = Buffer.alloc(vector.length * 8);
      vector.forEach((value, i) => expected.writeDoubleLE(value, i * 8));
      for (const row of rows.filter((entry) => entry.hash !== "empty")) {
        if (!(row.embedding instanceof Uint8Array)) {
          throw new Error("Missing vector BLOB");
        }
        expect(Buffer.from(row.embedding).equals(expected)).toBe(true);
      }
      const input: MemorySourceIndexReplacement = {
        source: "memory",
        entry: { path: "memory/large.md", hash: "version1", mtimeMs: 1, size: 800000 },
        model: "boundary",
        now: 1,
        vectorReady: false,
        chunks: [0, 1].map((i) => ({
          hash: "chunk-" + i,
          text: "Synthetic ".repeat(40000),
          startLine: i + 1,
          endLine: i + 1,
          importance: null,
          triggers: null,
          projectKey: null,
        })),
        embeddings: [[], vector],
      };
      let sourceBatches = 0;
      for (const batch of memoryPublicationBatches(input)) {
        sourceBatches++;
        expect(serialize(batch).byteLength).toBeLessThanOrEqual(512 * 1024);
      }
      expect(sourceBatches).toBeGreaterThan(1);
      expect(
        await owner.replaceSource(
          input,
          () => undefined,
          async () => false,
        ),
      ).toBeUndefined();
      expect(owner.db.prepare("SELECT count(*) AS n FROM memory_index_chunks").get()).toEqual({
        n: 0,
      });
      expect(
        await owner.replaceSource(
          input,
          () => undefined,
          async () => true,
        ),
      ).toBe(true);
      const sourceRows = owner.db
        .prepare("SELECT text, embedding FROM memory_index_chunks ORDER BY start_line")
        .all();
      expect(sourceRows).toHaveLength(2);
      expect(sourceRows[0]?.text).toBe(input.chunks[0]?.text);
      expect(sourceRows[1]?.text).toBe(input.chunks[1]?.text);
      expect(sourceRows[0]?.embedding).toEqual(new Uint8Array(0));
      // Source JSON intentionally normalizes -0, unlike the binary64 cache contract.
      expected.writeDoubleLE(0, 0);
      const sourceVector = sourceRows[1]?.embedding;
      if (!(sourceVector instanceof Uint8Array)) {
        throw new Error("Missing source vector BLOB");
      }
      expect(Buffer.from(sourceVector).equals(expected)).toBe(true);
      const sessions: MemorySourceIndexReplacement = {
        ...input,
        source: "sessions",
        agentId: "main",
        sessionId: "forgotten",
      };
      await expect(
        owner.replaceSource(
          sessions,
          () => undefined,
          async () => true,
        ),
      ).rejects.toThrow("forgotten");
      expect(owner.db.prepare("SELECT count(*) AS n FROM memory_index_chunks").get()).toEqual({
        n: 2,
      });
      await owner.closePublicationWorker();
      expect(owner.db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      console.log(
        "STAGED_BOUNDARY",
        JSON.stringify({
          cacheBatches: batches,
          sourceBatches,
          largestBatch,
          cacheRows: rows.length,
        }),
      );
    } finally {
      await owner.closeShadow();
    }
  }, 60_000);
});
