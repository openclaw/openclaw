import fs from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bm25RankToScore } from "./keyword-query.js";
import { searchKeyword } from "./manager-search.js";
import { insertKeywordFixture } from "./manager-search.test-support.js";
import { hasTrigramTokenizerForTests } from "./unicode-query.test-support.js";

type Tokenizer = "unicode61" | "trigram";
type Document = { id: string; text: string; source?: "memory" | "sessions" };
type SearchOptions = Partial<Pick<Parameters<typeof searchKeyword>[0], "limit" | "sourceFilter">>;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const hasTrigram = hasTrigramTokenizerForTests();

async function withSearch(
  ftsTokenizer: Tokenizer,
  documents: Document[],
  run: (
    search: (query: string, options?: SearchOptions) => ReturnType<typeof searchKeyword>,
    db: DatabaseSync,
  ) => Promise<void>,
  databasePath = ":memory:",
) {
  let db = new DatabaseSync(databasePath);
  try {
    const schema = ensureMemoryIndexSchema({
      db,
      cacheEnabled: false,
      ftsEnabled: true,
      ftsTokenizer,
    });
    expect(schema.ftsAvailable).toBe(true);
    for (const document of documents) {
      insertKeywordFixture(db, {
        ...document,
        path: `memory/${document.id}.md`,
        model: "fts-only",
        endLine: 1,
      });
    }
    if (databasePath !== ":memory:") {
      // Close the existing-format writer before testing the new query owner.
      // A read-only reopen makes a hidden migration or reindex fail visibly.
      db.close();
      db = new DatabaseSync(databasePath, { readOnly: true });
    }
    await run(
      (query, options = {}) =>
        searchKeyword({
          db,
          ftsTable: "memory_index_chunks_fts",
          ftsTokenizer,
          query,
          limit: 10,
          snippetMaxChars: 200,
          sourceFilter: { sql: "", params: [] },
          ...options,
        }),
      db,
    );
  } finally {
    db.close();
  }
}

const tokenizers = ["unicode61", "trigram"] as const;
const forms = ["NFC", "NFD"] as const;

describe("memory keyword query Unicode forms", () => {
  it.for(tokenizers)(
    "reads a reopened existing %s index without rewriting it",
    async (tokenizer, context) => {
      if (tokenizer === "trigram" && !hasTrigram) {
        context.skip("SQLite does not provide the optional trigram tokenizer");
      }
      const databasePath = join(tempDirs.make("openclaw-memory-existing-index-"), "index.sqlite");
      const documents = [
        { id: "latin", text: "München weather" },
        { id: "korean", text: "한국어 weather".normalize("NFD") },
        { id: "control", text: "quartz handbook" },
      ];
      await withSearch(
        tokenizer,
        documents,
        async (search) => {
          const originalBytes = fs.readFileSync(databasePath);
          for (const { query, expected } of [
            { query: "München".normalize("NFD"), expected: "latin" },
            { query: "한국어", expected: "korean" },
            { query: "quartz", expected: "control" },
          ]) {
            const ids = (await search(query)).map((hit) => hit.id);
            expect(ids).toEqual([expected]);
          }
          expect(await search("unrecordedword")).toEqual([]);
          expect(fs.readFileSync(databasePath)).toEqual(originalBytes);
        },
        databasePath,
      );
    },
  );

  it.for(
    tokenizers.flatMap((tokenizer) =>
      ["München", "ǽ", "ộ", "café東京", "한국어", "Μαΐου", "\u{11315}\u{1134b}"].flatMap((word) =>
        forms.map((stored) => ({ tokenizer, word, stored })),
      ),
    ),
  )(
    "matches $stored $word text with either query form using $tokenizer",
    async ({ tokenizer, word, stored }, context) => {
      if (tokenizer === "trigram" && !hasTrigram) {
        context.skip("SQLite does not provide the optional trigram tokenizer");
      }
      const text = `${word} weather`.normalize(stored);
      await withSearch(
        tokenizer,
        [
          { id: "city", text },
          { id: "control", text: "quartz handbook" },
        ],
        async (search) => {
          for (const query of forms) {
            expect((await search(word.normalize(query))).map((hit) => hit.id)).toEqual(["city"]);
          }
        },
      );
    },
  );

  it("recalls a Unicode compatibility alias with unicode61", async () => {
    await withSearch("unicode61", [{ id: "cjk", text: "豈 weather" }], async (search) => {
      expect((await search("豈")).map((hit) => hit.id)).toEqual(["cjk"]);
    });
  });

  it.for(["re\u0340sume\u0301", "re\u0341sume\u0301", "mu\u0344nchen"])(
    "retains canonical alternatives for separator mark query %s",
    async (query) => {
      await withSearch(
        "unicode61",
        [
          { id: "canonical", text: query.normalize("NFC") },
          { id: "control", text: "quartz handbook" },
        ],
        async (search) => {
          expect((await search(query)).map((hit) => hit.id)).toEqual(["canonical"]);
        },
      );
    },
  );

  it.for(tokenizers)(
    "does not broaden canonical Latin terms to separator variants with %s",
    async (tokenizer, context) => {
      if (tokenizer === "trigram" && !hasTrigram) {
        context.skip("SQLite does not provide the optional trigram tokenizer");
      }
      await withSearch(
        tokenizer,
        [
          { id: "canonical", text: "München weather".normalize("NFD") },
          { id: "space", text: "Mu nchen weather" },
          { id: "hyphen", text: "Mu-nchen weather" },
        ],
        async (search) => {
          for (const form of forms) {
            expect((await search("München".normalize(form))).map((hit) => hit.id)).toEqual([
              "canonical",
            ]);
          }
        },
      );
    },
  );

  it.for(tokenizers)(
    "keeps AND semantics for mixed-form words with %s",
    async (tokenizer, context) => {
      if (tokenizer === "trigram" && !hasTrigram) {
        context.skip("SQLite does not provide the optional trigram tokenizer");
      }
      await withSearch(
        tokenizer,
        [
          { id: "both", text: `München ${"caféteria".normalize("NFD")}` },
          { id: "city", text: "München weather" },
          { id: "lunch", text: "caféteria handbook" },
        ],
        async (search) => {
          for (const form of forms) {
            expect(
              (await search("München caféteria".normalize(form))).map((hit) => hit.id),
            ).toEqual(["both"]);
          }
          expect(await search("München unrecordedword")).toEqual([]);
        },
      );
    },
  );

  it.skipIf(!hasTrigram)("keeps short canonical trigram terms in substring fallback", async () => {
    await withSearch(
      "trigram",
      [
        { id: "accented", text: "fé noir".normalize("NFD") },
        { id: "plain", text: "fe noir" },
      ],
      async (search) => {
        for (const form of forms) {
          const hits = await search("fé".normalize(form));
          expect(hits.map((hit) => hit.id)).toEqual(["accented"]);
          expect(hits[0]?.textScore).toBe(0);
          expect((await search("fé noir".normalize(form))).map((hit) => hit.id)).toEqual([
            "accented",
          ]);
        }
        expect(await search("\u0308 !!!")).toEqual([]);
      },
    );
  });

  it.for(tokenizers)(
    "preserves scoped ranked limits for canonical %s queries",
    async (tokenizer, context) => {
      if (tokenizer === "trigram" && !hasTrigram) {
        context.skip("SQLite does not provide the optional trigram tokenizer");
      }
      const documents: Document[] = Array.from({ length: 64 }, (_, i) => ({
        id: `item-${i}`,
        text: "München weather".normalize(i % 3 === 0 ? "NFD" : "NFC"),
        source: i % 2 === 0 ? "memory" : "sessions",
      }));
      await withSearch(tokenizer, documents, async (search, db) => {
        let examined = 0;
        db.function("observe_candidate", () => {
          examined++;
          return 1;
        });
        const hits = await search("München".normalize("NFD"), {
          limit: 3,
          sourceFilter: {
            sql: " AND source = ? AND observe_candidate() = 1",
            params: ["sessions"],
          },
        });
        expect(hits).toHaveLength(3);
        expect(new Set(hits.map((hit) => hit.id)).size).toBe(3);
        expect(hits.every((hit) => hit.source === "sessions")).toBe(true);
        expect(examined).toBeLessThanOrEqual(6);
        expect(await search("München", { limit: 0 })).toEqual([]);
      });
    },
  );

  it.for([
    { tokenizer: "unicode61" as const, word: "München" },
    { tokenizer: "unicode61" as const, word: "café東京" },
    { tokenizer: "unicode61" as const, word: "caféǽ" },
    { tokenizer: "unicode61" as const, word: "Kelvin" },
    { tokenizer: "unicode61" as const, word: "Ωmega" },
    { tokenizer: "unicode61" as const, word: "α\u0301\u0323" },
    { tokenizer: "unicode61" as const, word: "re\u0343sume" },
    { tokenizer: "unicode61" as const, word: "re\u0343\u0343sume" },
    { tokenizer: "trigram" as const, word: "München" },
    { tokenizer: "trigram" as const, word: "Kelvin" },
    { tokenizer: "trigram" as const, word: "Ωmega" },
  ])(
    "does not double-count canonical $tokenizer $word phrases",
    async ({ tokenizer, word }, context) => {
      if (tokenizer === "trigram" && !hasTrigram) {
        context.skip("SQLite does not provide the optional trigram tokenizer");
      }
      await withSearch(
        tokenizer,
        [
          { id: "city", text: `${word} weather`.normalize("NFD") },
          { id: "control", text: "quartz handbook" },
        ],
        async (search, db) => {
          const literal = db
            .prepare(
              "SELECT bm25(memory_index_chunks_fts) AS rank FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ?",
            )
            .get(`"${word.normalize("NFD")}"`) as { rank: number };
          for (const query of new Set([word, word.normalize("NFD")])) {
            const canonical = await search(query);
            expect(canonical.map((hit) => hit.id)).toEqual(["city"]);
            expect(canonical[0]?.textScore).toBe(bm25RankToScore(literal.rank));
            expect(await search(`${query} ${query}`)).toEqual(canonical);
          }
        },
      );
    },
  );

  it("preserves whole Unicode words in MATCH-error fallback", async () => {
    await withSearch(
      "unicode61",
      [
        { id: "city", text: "München weather" },
        { id: "split", text: "Mu nchen weather" },
      ],
      async (search, db) => {
        const prepare = vi.spyOn(db, "prepare").mockImplementationOnce(() => {
          throw new Error("FTS5 MATCH failed");
        });
        try {
          const hits = await search("München".normalize("NFD"));
          expect(hits.map((hit) => hit.id)).toEqual(["city"]);
          expect(hits[0]?.textScore).toBe(0);
        } finally {
          prepare.mockRestore();
        }
      },
    );
  });
});
