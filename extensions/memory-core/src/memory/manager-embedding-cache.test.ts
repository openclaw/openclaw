// Memory Core tests cover manager embedding cache plugin behavior.
import {
  ensureMemoryIndexSchema,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import {
  collectMemoryCachedEmbeddings,
  loadMemoryEmbeddingCache,
  upsertMemoryEmbeddingCache,
} from "./manager-embedding-cache.js";

describe("memory embedding cache", () => {
  const { DatabaseSync } = requireNodeSqlite();

  function createDb() {
    const db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: true,
      ftsEnabled: false,
      ftsTokenizer: "unicode61",
    });
    return db;
  }

  it("loads cached embeddings for the active provider key", () => {
    const db = createDb();
    try {
      upsertMemoryEmbeddingCache({
        db,
        enabled: true,
        provider: { id: "openai", model: "text-embedding-3-small" },
        providerKey: "provider-key",
        // Float32-exactly-representable values: embeddings are persisted as a
        // packed Float32 BLOB, so non-representable doubles (e.g. 0.1) would
        // round-trip with the expected f32 quantization rather than exactly.
        entries: [
          { hash: "a", embedding: [0.5, 0.25] },
          { hash: "b", embedding: [0.75, 0.125] },
        ],
        now: 123,
      });

      const cached = loadMemoryEmbeddingCache({
        db,
        enabled: true,
        providerIdentities: [
          {
            provider: "openai",
            model: "text-embedding-3-small",
            providerKey: "provider-key",
          },
        ],
        hashes: ["a", "b", "a"],
      });

      expect(cached).toEqual(
        new Map([
          ["a", [0.5, 0.25]],
          ["b", [0.75, 0.125]],
        ]),
      );
    } finally {
      db.close();
    }
  });

  it("loads provider-declared alias cache rows without accepting arbitrary identities", () => {
    const db = createDb();
    try {
      upsertMemoryEmbeddingCache({
        db,
        enabled: true,
        provider: { id: "local", model: "/cache/default.gguf" },
        providerKey: "provider-key-alias",
        entries: [{ hash: "alias", embedding: [0.5, 0.25] }],
      });
      upsertMemoryEmbeddingCache({
        db,
        enabled: true,
        provider: { id: "local", model: "/other/default.gguf" },
        providerKey: "provider-key-arbitrary",
        entries: [{ hash: "arbitrary", embedding: [0.75, 0.125] }],
      });

      const cached = loadMemoryEmbeddingCache({
        db,
        enabled: true,
        providerIdentities: [
          {
            provider: "local",
            model: "hf:owner/default.gguf",
            providerKey: "provider-key-current",
          },
          {
            provider: "local",
            model: "/cache/default.gguf",
            providerKey: "provider-key-alias",
          },
        ],
        hashes: ["alias", "arbitrary"],
      });

      expect(cached).toEqual(new Map([["alias", [0.5, 0.25]]]));
    } finally {
      db.close();
    }
  });

  it("round-trips a freshly written BLOB row at Float32 precision", () => {
    const db = createDb();
    try {
      const embedding = [0.5, -0.25, 1.5, 0, 0.125, -3.75];
      upsertMemoryEmbeddingCache({
        db,
        enabled: true,
        provider: { id: "openai", model: "text-embedding-3-small" },
        providerKey: "provider-key",
        entries: [{ hash: "blob", embedding }],
      });

      // New rows are persisted as a packed Float32 BLOB, not JSON TEXT.
      const stored = db
        .prepare("SELECT typeof(embedding) AS kind FROM memory_embedding_cache WHERE hash = ?")
        .get("blob") as { kind: string };
      expect(stored.kind).toBe("blob");

      const cached = loadMemoryEmbeddingCache({
        db,
        enabled: true,
        providerIdentities: [
          {
            provider: "openai",
            model: "text-embedding-3-small",
            providerKey: "provider-key",
          },
        ],
        hashes: ["blob"],
      });

      expect(cached.get("blob")).toEqual(embedding);
    } finally {
      db.close();
    }
  });

  it("still reads legacy JSON TEXT rows with no migration", () => {
    const db = createDb();
    try {
      const embedding = [0.1, 0.2, 0.3, 0.4];
      // Simulate a row written by the previous (JSON TEXT) cache format.
      db.prepare(
        `INSERT INTO memory_embedding_cache
           (provider, model, provider_key, hash, embedding, dims, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "openai",
        "text-embedding-3-small",
        "provider-key",
        "legacy",
        JSON.stringify(embedding),
        embedding.length,
        1,
      );

      const stored = db
        .prepare("SELECT typeof(embedding) AS kind FROM memory_embedding_cache WHERE hash = ?")
        .get("legacy") as { kind: string };
      expect(stored.kind).toBe("text");

      const cached = loadMemoryEmbeddingCache({
        db,
        enabled: true,
        providerIdentities: [
          {
            provider: "openai",
            model: "text-embedding-3-small",
            providerKey: "provider-key",
          },
        ],
        hashes: ["legacy"],
      });

      expect(cached.get("legacy")).toEqual(embedding);
    } finally {
      db.close();
    }
  });

  it("reuses cached embeddings on forced reindex instead of scheduling new embeds", () => {
    const cached = new Map<string, number[]>([
      ["alpha", [0.1, 0.2]],
      ["beta", [0.3, 0.4]],
    ]);
    const embedMissing = vi.fn();

    const plan = collectMemoryCachedEmbeddings({
      chunks: [{ hash: "alpha" }, { hash: "beta" }],
      cached,
    });

    if (plan.missing.length > 0) {
      embedMissing(plan.missing);
    }

    expect(plan.embeddings).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(plan.missing).toHaveLength(0);
    expect(embedMissing).not.toHaveBeenCalled();
  });
});
