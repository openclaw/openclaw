import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ensureSqliteLibrarySelected,
  openNodeSqliteDatabase,
} from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import {
  encodeMemoryEmbedding,
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runVectorKnnQuery, vectorToBlob } from "./manager-search-knn.test-support.js";
import type { MemoryKeywordWorkerQuery, MemoryVectorWorkerQuery } from "./manager-search-types.js";
import { insertKeywordFixture } from "./manager-search.test-support.js";
import { executeMemorySearchWorkerQuery } from "./manager-search.worker.js";

// Frozen from the unchanged direct SQLite helpers before routing these cases through
// worker dispatch. Hash the exact SQL bytes, including whitespace and statement order.
// Keyword entries include the `LIMIT +?` and `LIKE (? || '')` bindings.
const baselineStatements = {
  keyword: [
    "0d8edb57312b94e844b0dbb9c5b52492984c7144b0128e97b10b08a4db6c61f1",
    "d21b7990e9e84dd27defe48d362fbc1b9052516c16f7f12ed8585f816a7f804d",
    "0452ff06b004ffa625a01700b4807576c1fc9b47fb5692b2228e9073a6e62416",
    "6e57716adee36fd2e181a5439b23095e7b5c7efe8c37a14521ca767088e493cc",
  ],
  fallback: [
    "93b82ea8ca193cfa2452b7c06fc751197a8ce4a6dcc1530908e7e5f1f1b41f38",
    "6a329cef9cc8add5d12b888e2885089cab289ba96409cfd472a0f707898cef86",
    "5a73b0faac527e7cb502b22cfb78bedfa886e43196bf70cc6de77a238a4a048c",
  ],
  knn: ["093ec9a7efe5720a5c0c931a8401d997b247a27b421d4d3c36ffa83e52ed42c8"],
};

const keywordQuery: MemoryKeywordWorkerQuery = {
  body: {
    ftsTable: "memory_index_chunks_fts",
    query: "cafe",
    ftsTokenizer: "unicode61",
    limit: 2,
    snippetMaxChars: 80,
    sourceFilter: { sql: " AND source IN (?)", params: ["memory"] },
  },
  path: {
    pathFtsTable: "memory_index_paths_fts",
    query: "cafe",
    ftsTokenizer: "unicode61",
    exactPathLimit: 2,
    limit: 2,
    snippetMaxChars: 80,
    sourceFilter: { sql: " AND memory_index_paths_fts.source IN (?)", params: ["memory"] },
  },
};
const vectorQuery: MemoryVectorWorkerQuery = {
  providerModel: "target",
  providerModelAliases: ["target-alias"],
  queryVec: [1, 0],
  limit: 2,
  snippetMaxChars: 80,
  sourceFilter: { sql: " AND source IN (?)", params: ["memory"] },
};

async function capture<T>(db: DatabaseSync, operation: () => Promise<T>) {
  const prepares = vi.spyOn(db, "prepare");
  try {
    const value = await operation();
    return {
      value,
      statements: prepares.mock.calls.map(([statement]) =>
        createHash("sha256").update(statement).digest("hex"),
      ),
    };
  } finally {
    prepares.mockRestore();
  }
}

describe("SQLite memory search statement compatibility", () => {
  let db: DatabaseSync;
  const precise = [0.12345678912345678, 0.9876543219876543];

  beforeAll(async () => {
    ensureSqliteLibrarySelected();
    db = openNodeSqliteDatabase(":memory:", { allowExtension: true });
    const loaded = await loadSqliteVecExtension({ db });
    expect(loaded.ok, loaded.error).toBe(true);
    const schema = ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
    expect(schema.ftsAvailable, schema.ftsError).toBe(true);
    db.exec(
      "CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[2])",
    );
    const rows = [
      { id: "exact", path: "memory/cafe.md", text: "café blue fox", vector: [1, 0] },
      {
        id: "precise",
        path: "memory/cafe-notes.md",
        text: "café blue fox notes",
        vector: precise,
        model: "target-alias",
      },
      {
        id: "wrong-model",
        path: "memory/other.md",
        text: "unrelated",
        vector: [1, 0],
        model: "other",
      },
      {
        id: "wrong-source",
        path: "sessions/cafe.md",
        text: "café blue fox",
        vector: [1, 0],
        source: "sessions" as const,
      },
    ];
    for (const row of rows) {
      insertKeywordFixture(db, { ...row, model: row.model ?? "target" });
      db.prepare("UPDATE memory_index_chunks SET embedding = ? WHERE id = ?").run(
        encodeMemoryEmbedding(row.vector),
        row.id,
      );
      db.prepare("INSERT INTO memory_index_chunks_vec(id, embedding) VALUES (?, ?)").run(
        row.id,
        vectorToBlob(row.vector),
      );
    }
  });

  afterAll(() => db?.close());

  it("retains the text and exact-path statements across worker dispatch", async () => {
    const captured = await capture(db, () =>
      executeMemorySearchWorkerQuery(db, { kind: "keyword", query: keywordQuery }),
    );
    expect(captured.value.body.rows.map((row) => row.id)).toEqual(["exact", "precise"]);
    expect(captured.value.path.rows.map((row) => row.id)).toEqual(["exact", "precise"]);
    expect(captured.statements).toEqual(baselineStatements.keyword);
  });

  it("retains the binary64 fallback statements and score across worker dispatch", async () => {
    const captured = await capture(db, () =>
      executeMemorySearchWorkerQuery(db, { kind: "vector", query: vectorQuery }),
    );
    expect(captured.value.rows.map((row) => row.id)).toEqual(["exact", "precise"]);
    const expected = precise[0]! / Math.sqrt(precise[0]! ** 2 + precise[1]! ** 2);
    expect(captured.value.rows[1]?.score).toBe(expected);
    expect(expected).not.toBe(
      Math.fround(precise[0]!) /
        Math.sqrt(Math.fround(precise[0]!) ** 2 + Math.fround(precise[1]!) ** 2),
    );
    expect(captured.statements).toEqual(baselineStatements.fallback);
  });

  it("retains the native vec0 KNN statement used by the child reader", async () => {
    const captured = await capture(db, () =>
      runVectorKnnQuery(db, {
        providerModels: ["target", "target-alias"],
        queryVec: [1, 0],
        limit: 2,
        snippetMaxChars: 80,
        sourceFilter: { sql: " AND c.source IN (?)", params: ["memory"] },
      }),
    );
    expect(captured.value.fallbackScanRequired).toBe(false);
    expect(captured.value.rows.map((row) => row.id)).toEqual(["exact", "precise"]);
    expect(captured.statements).toEqual(baselineStatements.knn);
  });
});
