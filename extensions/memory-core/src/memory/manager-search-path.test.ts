// Real SQLite path search, exact-file precedence, and candidate budgets.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bm25RankToScore } from "./keyword-query.js";
import { searchPathKeyword } from "./manager-search.js";
import { createMemorySearchDb, insertKeywordFixture } from "./manager-search.test-support.js";

type PathSearchOptions = Omit<Parameters<typeof searchPathKeyword>[0], "db" | "query">;

function searchPathKeywordFixture(
  db: DatabaseSync,
  query: string,
  options: Partial<PathSearchOptions> = {},
) {
  return searchPathKeyword({
    db,
    pathFtsTable: "memory_index_paths_fts",
    query,
    ftsTokenizer: "unicode61",
    limit: 1,
    snippetMaxChars: 200,
    sourceFilter: { sql: "", params: [] },
    ...options,
  });
}

describe("searchPathKeyword", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const db of databases.splice(0)) {
      db.close();
    }
  });
  function createDb(options: Parameters<typeof createMemorySearchDb>[0] = {}) {
    const { db, schema } = createMemorySearchDb(options);
    databases.push(db);
    expect(schema.ftsAvailable, schema.ftsError).toBe(true);
    return db;
  }

  it("keeps filename token matching strict so foo.md does not match unrelated .md paths", async () => {
    const db = createDb({ ftsTokenizer: "unicode61" });
    insertKeywordFixture(db, { id: "target", path: "memory/notes/foo.md" });
    insertKeywordFixture(db, { id: "other-1", path: "memory/notes/bar.md" });
    insertKeywordFixture(db, { id: "other-2", path: "memory/notes/baz.md" });

    const results = await searchPathKeywordFixture(db, "foo.md", { limit: 10 });

    expect(results.map((entry) => entry.id)).toEqual(["target"]);
  });

  it.each([
    ["unicode61", "common"],
    ["trigram", "README.md"],
    ["trigram", "成语"],
  ] as const)(
    "bounds first-chunk work with stale statistics for %s query %s",
    async (ftsTokenizer, query) => {
      const db = createDb({ ftsTokenizer });
      insertKeywordFixture(db, { id: "seed", path: "seed.md" });
      // Analyze an almost-empty index before it grows, as during an upgrade.
      db.exec("PRAGMA analysis_limit=1000; ANALYZE main");
      db.prepare(
        "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, 'memory', '', 0, 0)",
      ).run("memory/common/成语/00-empty/README.md");
      for (let index = 0; index < 64; index++) {
        for (let chunk = 2; chunk >= 0; chunk--) {
          insertKeywordFixture(db, {
            id: `path-${index}-chunk-${chunk}`,
            path: `memory/common/成语/${String(index).padStart(3, "0")}/README.md`,
            source: index % 2 === 0 ? "memory" : "sessions",
            startLine: chunk * 5 + 1,
            endLine: chunk * 5 + 4,
            text: `body ${index}/${chunk} ` + "x".repeat(8_000),
          });
        }
      }
      let examinedChunkLines = 0;
      db.function("observe_path_chunk_line", (line) => {
        examinedChunkLines++;
        return line;
      });

      const queryPlans: string[] = [];
      let fetchedTextBytes = 0;
      const prepare = db.prepare.bind(db);
      const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
        // Observe sorting work without replacing the indexed chunks table.
        const statement = prepare(
          sql.replaceAll("candidate.start_line", "observe_path_chunk_line(candidate.start_line)"),
        );
        statement.all = new Proxy(statement.all.bind(statement), {
          apply(all, _receiver, values) {
            for (const row of prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values)) {
              queryPlans.push(String(row.detail));
            }
            const rows = all(...values);
            for (const row of rows) {
              if (typeof row.text === "string") {
                fetchedTextBytes += Buffer.byteLength(row.text);
              }
            }
            return rows;
          },
        });
        return statement;
      });
      const results = await searchPathKeywordFixture(db, query, {
        ftsTokenizer,
        limit: 2,
        sourceFilter: {
          sql: " AND memory_index_paths_fts.source IN (?)",
          params: ["memory"],
        },
      });

      prepareSpy.mockRestore();
      expect(results.map(({ id, snippet }) => ({ id, snippet }))).toEqual([
        { id: "path-0-chunk-0", snippet: "body 0/0 " + "x".repeat(191) },
        { id: "path-2-chunk-0", snippet: "body 2/0 " + "x".repeat(191) },
      ]);
      expect(queryPlans.length).toBeGreaterThan(0);
      expect(queryPlans.filter((detail) => /\bSCAN (?:c|candidate)\b/.test(detail))).toEqual([]);
      expect(examinedChunkLines).toBeGreaterThan(0);
      expect(examinedChunkLines).toBeLessThanOrEqual(16);
      expect(fetchedTextBytes).toBeLessThanOrEqual(4 * 200 * 4);
    },
  );

  it("applies short CJK trigram substring matching to the path table", async () => {
    const db = createDb({ ftsTokenizer: "trigram" });
    insertKeywordFixture(db, {
      id: "cjk-path",
      path: "memory/成语-notes.md",
    });
    insertKeywordFixture(db, {
      id: "cjk-exact",
      path: "memory/成语.md",
    });
    insertKeywordFixture(db, {
      id: "readme-exact",
      path: "memory/README.md",
    });
    insertKeywordFixture(db, {
      id: "normalized-exact",
      path: "memory/Cafe\u0301.md",
    });
    insertKeywordFixture(db, {
      id: "tokenless-exact",
      path: "memory/🧠.md",
    });

    const results = await searchPathKeywordFixture(db, "成语", {
      ftsTokenizer: "trigram",
      limit: 10,
    });

    expect(results.map((entry) => entry.id)).toEqual(["cjk-exact", "cjk-path"]);
    await expect(
      searchPathKeywordFixture(db, "成语.md", { ftsTokenizer: "trigram" }),
    ).resolves.toMatchObject([{ id: "cjk-exact", exactPathSpecificity: 2 }]);
    await expect(
      searchPathKeywordFixture(db, "README.md", { ftsTokenizer: "trigram" }),
    ).resolves.toMatchObject([{ id: "readme-exact", exactPathSpecificity: 2 }]);
    await expect(
      searchPathKeywordFixture(db, "CAFÉ", { ftsTokenizer: "trigram" }),
    ).resolves.toMatchObject([{ id: "normalized-exact", exactPathSpecificity: 1 }]);
    await expect(
      searchPathKeywordFixture(db, "🧠", { ftsTokenizer: "trigram" }),
    ).resolves.toMatchObject([{ id: "tokenless-exact", exactPathSpecificity: 1 }]);
  });

  it("bridges NFC trigram queries to partial NFD path spellings", async () => {
    const db = createDb({ ftsTokenizer: "trigram" });
    insertKeywordFixture(db, {
      id: "normalized-partial",
      path: "memory/Cafe\u0301-notes.md",
    });
    const search = (query: string) =>
      searchPathKeywordFixture(db, query, {
        ftsTokenizer: "trigram",
        limit: 10,
      });

    for (const query of ["Café", "fé"]) {
      const results = await search(query);
      expect(results).toMatchObject([{ id: "normalized-partial", exactPathSpecificity: 0 }]);
    }
  });

  it("matches partial Unicode path text with the default unicode61 tokenizer", async () => {
    const db = createDb();
    insertKeywordFixture(db, {
      id: "unicode61-partial",
      path: "memory/Café.md",
    });

    const search = (query: string) => searchPathKeywordFixture(db, query);

    for (const query of ["afé", "AFE\u0301", "memory afé"]) {
      await expect(search(query)).resolves.toMatchObject([
        { id: "unicode61-partial", exactPathSpecificity: 0 },
      ]);
    }
    await expect(search("emory afé")).resolves.toEqual([]);
  });

  it("bounds exact-path headroom independently from lexical candidates", async () => {
    const db = createDb();
    for (let index = 0; index < 1_000; index += 1) {
      const path = `memory/duplicates/${index.toString().padStart(3, "0")}/README.md`;
      insertKeywordFixture(db, {
        id: `duplicate-${index}`,
        path,
      });
    }
    for (let index = 0; index < 6; index += 1) {
      insertKeywordFixture(db, {
        id: `partial-${index}`,
        path: `memory/partial/${index}/notes-README.md.bak`,
      });
    }
    for (const path of ["a/README.md", "a/notes-README.md.bak"]) {
      insertKeywordFixture(db, { id: path, path, source: "sessions" });
    }

    for (const query of ["README.md", "README"]) {
      const ranks = db
        .prepare(
          "SELECT path, bm25(memory_index_paths_fts) AS rank FROM memory_index_paths_fts WHERE memory_index_paths_fts MATCH ? AND source = 'memory'",
        )
        .all(query === "README.md" ? '"README" AND "md"' : '"README"');
      const scores = new Map(
        ranks.map((row) => {
          if (typeof row.path !== "string" || typeof row.rank !== "number") {
            throw new Error("invalid SQLite path rank");
          }
          return [row.path, bm25RankToScore(row.rank)];
        }),
      );
      const results = await searchPathKeywordFixture(db, query, {
        exactPathLimit: 200,
        limit: 4,
        sourceFilter: {
          sql: " AND memory_index_paths_fts.source IN (?)",
          params: ["memory"],
        },
      });
      const expected = Array.from({ length: 204 }, (_, index) => {
        const exact = index < 200;
        const path = exact
          ? `memory/duplicates/${index.toString().padStart(3, "0")}/README.md`
          : `memory/partial/${index - 200}/notes-README.md.bak`;
        const score = scores.get(path);
        expect(score).toBeTypeOf("number");
        return {
          id: exact ? `duplicate-${index}` : `partial-${index - 200}`,
          path,
          source: "memory",
          startLine: 1,
          endLine: 2,
          snippet: "unrelated body",
          score,
          textScore: 0,
          pathScore: score,
          hasBodyMatch: false,
          exactPathSpecificity: exact ? (query === "README.md" ? 2 : 1) : 0,
        };
      });
      expect(results).toEqual(expected);
    }
  });
});
