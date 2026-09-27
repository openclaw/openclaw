// Real SQLite path search, exact-file precedence, and candidate budgets.
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { bm25RankToScore, buildFtsQuery } from "./keyword-query.js";
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
    buildFtsQuery,
    bm25RankToScore,
    ...options,
  });
}

describe("searchPathKeyword", () => {
  it.each([
    ["unicode61", "common"],
    ["unicode61", "README.md"],
    ["trigram", "common"],
    ["trigram", "README.md"],
  ] as const)(
    "resolves first chunks only within the retained %s window for %s",
    async (ftsTokenizer, query) => {
      const { db } = createMemorySearchDb({ ftsTokenizer });
      try {
        db.prepare(
          "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, 'memory', '', 0, 0)",
        ).run("memory/common/00-empty/README.md");
        for (let index = 0; index < 64; index++) {
          for (let chunk = 2; chunk >= 0; chunk--) {
            insertKeywordFixture(db, {
              id: `path-${index}-chunk-${chunk}`,
              path: `memory/common/${String(index).padStart(3, "0")}/README.md`,
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
        db.exec(`
          ALTER TABLE memory_index_chunks RENAME TO observed_chunks;
          CREATE VIEW memory_index_chunks AS
            SELECT id, path, source, observe_path_chunk_line(start_line) AS start_line,
                   end_line, text FROM observed_chunks;
        `);

        let fetchedTextBytes = 0;
        const prepare = db.prepare.bind(db);
        const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
          const statement = prepare(sql);
          statement.all = new Proxy(statement.all.bind(statement), {
            apply(all, _receiver, values) {
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
        expect(examinedChunkLines).toBeGreaterThan(0);
        expect(examinedChunkLines).toBeLessThanOrEqual(16);
        expect(fetchedTextBytes).toBeLessThanOrEqual(4 * 200 * 4);
      } finally {
        db.close();
      }
    },
  );

  it("returns the first scoped chunk and reserves exact precedence for path identifiers", async () => {
    const { db, schema } = createMemorySearchDb();
    try {
      if (!schema.ftsAvailable) {
        throw new Error(schema.ftsError ?? "FTS unavailable");
      }
      insertKeywordFixture(db, {
        id: "memory-late",
        path: "memory/projects/Project-Lantern.md",
        startLine: 20,
        endLine: 25,
        text: "later unrelated body",
      });
      insertKeywordFixture(db, {
        id: "memory-early",
        path: "memory/projects/Project-Lantern.md",
        endLine: 5,
        text: "early unrelated body",
      });
      insertKeywordFixture(db, {
        id: "session-early",
        path: "memory/projects/Project-Lantern.md",
        source: "sessions",
        text: "session unrelated body",
      });

      const search = (query: string) =>
        searchPathKeywordFixture(db, query, {
          limit: 10,
          sourceFilter: {
            sql: " AND memory_index_paths_fts.source IN (?)",
            params: ["memory"],
          },
        });

      const exact = await search("project-lantern");
      expect(exact).toHaveLength(1);
      expect(exact[0]).toMatchObject({
        id: "memory-early",
        path: "memory/projects/Project-Lantern.md",
        source: "memory",
        startLine: 1,
        snippet: "early unrelated body",
        exactPathSpecificity: 1,
        textScore: 0,
      });
      expect(exact[0]?.score).toBe(exact[0]?.pathScore);

      const token = await search("lantern");
      expect(token).toHaveLength(1);
      expect(token[0]?.exactPathSpecificity).toBe(0);
      expect(token[0]?.textScore).toBe(0);
      expect(token[0]?.score).toBe(token[0]?.pathScore);
      expect(token[0]?.score).toBeLessThan(1);
    } finally {
      db.close();
    }
  });

  it("finds an ASCII exact path amid many unrelated source rows", async () => {
    const { db, schema } = createMemorySearchDb();
    try {
      if (!schema.ftsAvailable) {
        throw new Error(schema.ftsError ?? "FTS unavailable");
      }
      const unrelatedCount = 256;
      const insertSource = db.prepare(
        "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, 'memory', ?, 0, 0)",
      );
      for (let index = 0; index < unrelatedCount; index += 1) {
        insertSource.run(`memory/unrelated-${index}.md`, `unrelated-${index}`);
      }
      insertSource.run("memory/project-lantern.notes.md", "near");
      insertKeywordFixture(db, {
        id: "exact-ascii-path",
        path: "memory/project-lantern.md",
      });

      const results = await searchPathKeywordFixture(db, "project-lantern");

      expect(results).toMatchObject([{ id: "exact-ascii-path", exactPathSpecificity: 1 }]);
    } finally {
      db.close();
    }
  });

  it("skips empty exact sources before applying the exact result limit", async () => {
    const { db, schema } = createMemorySearchDb();
    try {
      if (!schema.ftsAvailable) {
        throw new Error(schema.ftsError ?? "FTS unavailable");
      }
      db.prepare(
        "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, 0, 0)",
      ).run("a/foo.md", "memory", "empty-source");
      insertKeywordFixture(db, {
        id: "live-exact-source",
        path: "z/foo.md",
        text: "live exact source",
      });

      await expect(
        searchPathKeyword({
          db,
          pathFtsTable: "memory_index_paths_fts",
          query: "foo",
          ftsTokenizer: "unicode61",
          limit: 1,
          snippetMaxChars: 200,
          sourceFilter: { sql: "", params: [] },
          buildFtsQuery,
          bm25RankToScore,
        }),
      ).resolves.toMatchObject([{ id: "live-exact-source", exactPathSpecificity: 1 }]);
    } finally {
      db.close();
    }
  });

  it("keeps exact basename truncation independent of path BM25", async () => {
    const { db, schema } = createMemorySearchDb();
    try {
      if (!schema.ftsAvailable) {
        throw new Error(schema.ftsError ?? "FTS unavailable");
      }
      for (const fixture of [
        { id: "exact-a", path: "a/very/deep/foo.md" },
        { id: "exact-b", path: "b/foo.md" },
        { id: "exact-c", path: "c/foo.md" },
      ]) {
        insertKeywordFixture(db, fixture);
      }

      const results = await searchPathKeywordFixture(db, "foo.md", {
        limit: 2,
      });

      expect(results.map((entry) => entry.id)).toEqual(["exact-a", "exact-b"]);
      expect(results.every((entry) => entry.textScore === 0)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("ranks exact full names above last-extension stem collisions", async () => {
    const { db, schema } = createMemorySearchDb();
    try {
      if (!schema.ftsAvailable) {
        throw new Error(schema.ftsError ?? "FTS unavailable");
      }
      for (const fixture of [
        { id: "foo-stem", path: "a/foo.md.bak" },
        { id: "foo-basename", path: "z/foo.md" },
        { id: "bar-stem", path: "a/bar.md" },
        { id: "bar-basename", path: "z/bar" },
      ]) {
        insertKeywordFixture(db, fixture);
      }
      const search = (query: string) => searchPathKeywordFixture(db, query);

      await expect(search("foo.md")).resolves.toMatchObject([
        { id: "foo-basename", exactPathSpecificity: 2 },
      ]);
      await expect(search("bar")).resolves.toMatchObject([
        { id: "bar-basename", exactPathSpecificity: 2 },
      ]);
    } finally {
      db.close();
    }
  });

  it("keeps mixed-case Unicode exact identifiers in the predicate candidate set", async () => {
    const { db, schema } = createMemorySearchDb();
    try {
      if (!schema.ftsAvailable) {
        throw new Error(schema.ftsError ?? "FTS unavailable");
      }
      for (const fixture of [
        { id: "cyrillic-near", path: "МОСКВА.notes.md" },
        { id: "cyrillic-exact", path: "я/Москва.md" },
        { id: "cyrillic-unrelated", path: "Киев.md" },
      ]) {
        insertKeywordFixture(db, fixture);
      }

      const results = await searchPathKeywordFixture(db, "МОСКВА");

      expect(results).toMatchObject([{ id: "cyrillic-exact", exactPathSpecificity: 1 }]);
    } finally {
      db.close();
    }
  });

  it("applies the final exact predicate before limiting multi-dot and Unicode matches", async () => {
    const { db, schema } = createMemorySearchDb();
    try {
      if (!schema.ftsAvailable) {
        throw new Error(schema.ftsError ?? "FTS unavailable");
      }
      for (const fixture of [
        { id: "foo-near", path: "foo.bar.md" },
        { id: "foo-exact", path: "memory/deep/archive/foo.md" },
        { id: "unicode-near", path: "CAFÉ.notes.md" },
        { id: "unicode-exact", path: "memory/deep/Cafe\u0301.md" },
      ]) {
        insertKeywordFixture(db, fixture);
      }

      const search = (query: string) => searchPathKeywordFixture(db, query);

      await expect(search("foo")).resolves.toMatchObject([
        { id: "foo-exact", exactPathSpecificity: 1 },
      ]);
      await expect(search("CAFÉ")).resolves.toMatchObject([
        { id: "unicode-exact", exactPathSpecificity: 1 },
      ]);
    } finally {
      db.close();
    }
  });

  it("applies short CJK trigram substring matching to the path table", async () => {
    const { db, schema } = createMemorySearchDb({ ftsTokenizer: "trigram" });
    try {
      if (!schema.ftsAvailable) {
        return;
      }
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
        searchPathKeyword({
          db,
          pathFtsTable: "memory_index_paths_fts",
          query: "成语.md",
          ftsTokenizer: "trigram",
          limit: 1,
          snippetMaxChars: 200,
          sourceFilter: { sql: "", params: [] },
          buildFtsQuery,
          bm25RankToScore,
        }),
      ).resolves.toMatchObject([{ id: "cjk-exact", exactPathSpecificity: 2 }]);
      await expect(
        searchPathKeyword({
          db,
          pathFtsTable: "memory_index_paths_fts",
          query: "README.md",
          ftsTokenizer: "trigram",
          limit: 1,
          snippetMaxChars: 200,
          sourceFilter: { sql: "", params: [] },
          buildFtsQuery,
          bm25RankToScore,
        }),
      ).resolves.toMatchObject([{ id: "readme-exact", exactPathSpecificity: 2 }]);
      await expect(
        searchPathKeyword({
          db,
          pathFtsTable: "memory_index_paths_fts",
          query: "CAFÉ",
          ftsTokenizer: "trigram",
          limit: 1,
          snippetMaxChars: 200,
          sourceFilter: { sql: "", params: [] },
          buildFtsQuery,
          bm25RankToScore,
        }),
      ).resolves.toMatchObject([{ id: "normalized-exact", exactPathSpecificity: 1 }]);
      await expect(
        searchPathKeyword({
          db,
          pathFtsTable: "memory_index_paths_fts",
          query: "🧠",
          ftsTokenizer: "trigram",
          limit: 1,
          snippetMaxChars: 200,
          sourceFilter: { sql: "", params: [] },
          buildFtsQuery,
          bm25RankToScore,
        }),
      ).resolves.toMatchObject([{ id: "tokenless-exact", exactPathSpecificity: 1 }]);
    } finally {
      db.close();
    }
  });

  it("case-folds short Cyrillic and Greek trigram terms", async () => {
    const { db, schema } = createMemorySearchDb({ ftsTokenizer: "trigram" });
    try {
      if (!schema.ftsAvailable) {
        return;
      }
      for (const fixture of [
        { id: "cyrillic-short", path: "memory/Москва-notes.md" },
        { id: "greek-short", path: "memory/Αθήνα-notes.md" },
        { id: "cyrillic-negative", path: "memory/Мир.md" },
        { id: "greek-negative", path: "memory/Αλφα.md" },
      ]) {
        insertKeywordFixture(db, fixture);
      }
      expect(
        db.prepare("SELECT 1 FROM memory_index_paths_fts WHERE path LIKE ? LIMIT 1").get("%МО%"),
      ).toBeUndefined();
      expect(
        db.prepare("SELECT 1 FROM memory_index_paths_fts WHERE path LIKE ? LIMIT 1").get("%ΑΘ%"),
      ).toBeUndefined();
      const search = (query: string) =>
        searchPathKeywordFixture(db, query, {
          ftsTokenizer: "trigram",
        });

      await expect(search("МО")).resolves.toMatchObject([
        { id: "cyrillic-short", exactPathSpecificity: 0 },
      ]);
      await expect(search("ΑΘ")).resolves.toMatchObject([
        { id: "greek-short", exactPathSpecificity: 0 },
      ]);
    } finally {
      db.close();
    }
  });

  it("bridges NFC trigram queries to partial NFD path spellings", async () => {
    const { db, schema } = createMemorySearchDb({ ftsTokenizer: "trigram" });
    try {
      if (!schema.ftsAvailable) {
        return;
      }
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
    } finally {
      db.close();
    }
  });

  it("matches partial Unicode path text with the default unicode61 tokenizer", async () => {
    const { db, schema } = createMemorySearchDb();
    try {
      if (!schema.ftsAvailable) {
        return;
      }
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
    } finally {
      db.close();
    }
  });

  it("bounds exact-path headroom independently from lexical candidates", async () => {
    const { db, schema } = createMemorySearchDb();
    try {
      if (!schema.ftsAvailable) {
        throw new Error(schema.ftsError ?? "FTS unavailable");
      }
      const candidatePaths = new Set<string>();
      for (let index = 0; index < 1_000; index += 1) {
        const path = `memory/duplicates/${index.toString().padStart(3, "0")}/README.md`;
        candidatePaths.add(path);
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

      const snapshot = () => ({
        sources: db.prepare("SELECT * FROM memory_index_sources ORDER BY path, source").all(),
        chunks: db.prepare("SELECT * FROM memory_index_chunks ORDER BY id").all(),
        paths: db.prepare("SELECT * FROM memory_index_paths_fts ORDER BY path, source").all(),
      });
      const before = snapshot();
      const allResults: Array<Awaited<ReturnType<typeof searchPathKeywordFixture>>> = [];
      const work: Array<{ query: number; candidates: number }> = [];
      for (const query of ["README.md", "README", "README.md"]) {
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
        const counts = { query: 0, candidates: 0 };
        const spy = vi.spyOn(String.prototype, "replaceAll");
        let pending: ReturnType<typeof searchPathKeywordFixture>;
        try {
          pending = searchPathKeywordFixture(db, query, {
            exactPathLimit: 200,
            limit: 4,
            sourceFilter: {
              sql: " AND memory_index_paths_fts.source IN (?)",
              params: ["memory"],
            },
          });
        } finally {
          for (const [index, args] of spy.mock.calls.entries()) {
            const receiver = spy.mock.contexts[index];
            // Vitest types call records from replaceAll's final overload.
            if (args[0] === "\\" && Object.is(args[1], "/")) {
              if (receiver === query) {
                counts.query++;
              } else if (typeof receiver === "string" && candidatePaths.has(receiver)) {
                counts.candidates++;
              }
            }
          }
          spy.mockRestore();
        }
        const results = await pending;
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
        allResults.push(results);
        work.push(counts);
      }

      expect(allResults[0]).toEqual(allResults[2]);
      expect(snapshot()).toEqual(before);
      for (const counts of work) {
        expect(counts.candidates).toBeGreaterThanOrEqual(1_000);
        expect(counts.query).toBeLessThanOrEqual(2);
      }
    } finally {
      db.close();
    }
  });
});
