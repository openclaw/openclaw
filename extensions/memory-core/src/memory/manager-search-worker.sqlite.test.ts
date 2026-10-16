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
const baselineStatements = {
  keyword: [
    "4ef955cb4eb5d833877cc5481645d12d752c8ec66b563c9450f698551657be2d",
    "e0eb673f20e6406407742bdf77b68a4339fb325f93c57767d13341b8428aa173",
    "fa8fb1408e402a805b1bc7b4fdf56cd7a4574c43ef745c1b7c2a5cf7c74aa25f",
    "60ff181c3ad4dbf8a65f4ed156c75f1a49a1b2b6223f511a2d3786ce106aa950",
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
