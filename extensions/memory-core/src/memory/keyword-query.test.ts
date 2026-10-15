import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  buildMatchQueryFromTerms,
  planKeywordSearch,
  splitCodeIdentifierSubtokens,
} from "./keyword-query.js";
import { searchKeywordWithFallback } from "./manager-search.js";

function createInMemoryFtsDb(
  rows: Array<{ id: string; path: string; text: string }>,
): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE memory_index_chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX idx_memory_index_chunks_path_source ON memory_index_chunks(path, source);
    CREATE VIRTUAL TABLE memory_index_fts USING fts5(
      id UNINDEXED,
      path UNINDEXED,
      source UNINDEXED,
      start_line UNINDEXED,
      end_line UNINDEXED,
      text,
      tokenize='unicode61'
    );
    CREATE VIRTUAL TABLE memory_index_paths_fts USING fts5(
      path,
      source UNINDEXED,
      tokenize='unicode61'
    );
  `);
  const insertChunk = db.prepare(
    "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, text) VALUES (?, ?, 'memory', 1, 5, ?)",
  );
  const insertFts = db.prepare(
    "INSERT INTO memory_index_fts (id, path, source, start_line, end_line, text) VALUES (?, ?, 'memory', 1, 5, ?)",
  );
  const insertPath = db.prepare(
    "INSERT INTO memory_index_paths_fts (path, source) VALUES (?, 'memory')",
  );
  for (const row of rows) {
    insertChunk.run(row.id, row.path, row.text);
    insertFts.run(row.id, row.path, row.text);
    insertPath.run(row.path);
  }
  return db;
}

describe("keyword-query code identifier tokenization and fallback", () => {
  it("splits CamelCase, PascalCase, acronym, and snake_case identifiers into sub-tokens", () => {
    expect(splitCodeIdentifierSubtokens("repairDoctorSqliteNoCow")).toEqual([
      "repair",
      "Doctor",
      "Sqlite",
      "No",
      "Cow",
    ]);
    expect(splitCodeIdentifierSubtokens("doctor_sqlite_nocow")).toEqual([
      "doctor",
      "sqlite",
      "nocow",
    ]);
    expect(splitCodeIdentifierSubtokens("parseHTTPResponseURL")).toEqual([
      "parse",
      "HTTP",
      "Response",
      "URL",
    ]);
    expect(splitCodeIdentifierSubtokens("ordinary")).toEqual([]);
  });

  it("includes compound and sub-token conjunction alternatives in FTS5 match queries", () => {
    const query = buildMatchQueryFromTerms(["repairDoctorSqliteNoCow"], "unicode61", false);
    expect(query).toBe(
      '("repairDoctorSqliteNoCow" OR ("repair" AND "Doctor" AND "Sqlite" AND "No" AND "Cow"))',
    );
    const snakeQuery = buildMatchQueryFromTerms(["doctor_sqlite_no_cow"], "unicode61", false);
    expect(snakeQuery).toBe(
      '("doctor_sqlite_no_cow" OR "doctorsqlitenocow" OR ("doctor" AND "sqlite" AND "no" AND "cow"))',
    );
  });

  it("recalls CamelCase, snake_case, kebab-case, and partial sub-identifiers across SQLite FTS5", async () => {
    const db = createInMemoryFtsDb([
      {
        id: "chunk-camel",
        path: "memory/doctor-nocow.md",
        text: "Helper repairDoctorSqliteNoCow verifies Btrfs NOCOW attributes before migration.",
      },
      {
        id: "chunk-kebab",
        path: "memory/kebab.md",
        text: "Branch perf/doctor-fuser-preflight checks RENAME_EXCHANGE before migration.",
      },
    ]);

    try {
      const runSearch = async (query: string) =>
        await searchKeywordWithFallback({
          db,
          body: {
            ftsTable: "memory_index_fts",
            query,
            ftsTokenizer: "unicode61",
            limit: 5,
            snippetMaxChars: 300,
            sourceFilter: { sql: "", params: [] },
            boostFallbackRanking: true,
          },
          path: {
            pathFtsTable: "memory_index_paths_fts",
            query,
            ftsTokenizer: "unicode61",
            limit: 5,
            snippetMaxChars: 300,
            sourceFilter: { sql: "", params: [] },
          },
        });

      // 1. CamelCase query matches kebab-case chunk immediately via sub-token conjunction
      const fromCamelToKebab = await runSearch("doctorFuserPreflight");
      expect(fromCamelToKebab.body.rows.map((r) => r.id)).toContain("chunk-kebab");

      // 2. Partial CamelCase sub-identifier ("SqliteNoCow") recalls full CamelCase identifier ("repairDoctorSqliteNoCow")
      const partialCamel = await runSearch("SqliteNoCow");
      expect(partialCamel.body.rows.map((r) => r.id)).toContain("chunk-camel");

      // 3. snake_case query ("doctor_sqlite_nocow") recalls CamelCase identifier ("repairDoctorSqliteNoCow")
      const fromSnakeToCamel = await runSearch("doctor_sqlite_nocow");
      expect(fromSnakeToCamel.body.rows.map((r) => r.id)).toContain("chunk-camel");
    } finally {
      db.close();
    }
  });

  it("preserves trigram short-token routing and CJK substring plans", () => {
    const plan = planKeywordSearch({
      query: "内存 repairDoctorSqliteNoCow",
      ftsTokenizer: "trigram",
      canonicalVariants: true,
    });
    expect(plan.substringTerms).toEqual(["内存"]);
    expect(plan.matchQuery).toContain('"repairDoctorSqliteNoCow"');
  });
});
