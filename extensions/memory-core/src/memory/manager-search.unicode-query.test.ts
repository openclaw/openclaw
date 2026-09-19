import { DatabaseSync } from "node:sqlite";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it } from "vitest";
import { bm25RankToScore, buildFtsQuery } from "./keyword-query.js";
import { searchKeyword } from "./manager-search.js";

type Tokenizer = "unicode61" | "trigram";
type Document = { id: string; text: string; source?: "memory" | "sessions" };
type SearchOptions = Partial<
  Pick<Parameters<typeof searchKeyword>[0], "limit" | "sourceFilter" | "buildFtsQuery">
>;

async function withSearch(
  ftsTokenizer: Tokenizer,
  documents: Document[],
  run: (
    search: (query: string, options?: SearchOptions) => ReturnType<typeof searchKeyword>,
    db: DatabaseSync,
  ) => Promise<void>,
) {
  const db = new DatabaseSync(":memory:");
  try {
    const schema = ensureMemoryIndexSchema({
      db,
      cacheEnabled: false,
      ftsEnabled: true,
      ftsTokenizer,
    });
    expect(schema.ftsAvailable).toBe(true);
    for (const document of documents) {
      const path = `memory/${document.id}.md`;
      const source = document.source ?? "memory";
      db.prepare(
        "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, 0, 0)",
      ).run(path, source, document.id);
      db.prepare(
        "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, 1, 1, ?, 'fts-only', ?, '[]', 0)",
      ).run(document.id, path, source, document.id, document.text);
      db.prepare(
        "INSERT INTO memory_index_chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, 'fts-only', 1, 1)",
      ).run(document.text, document.id, path, source);
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
          buildFtsQuery,
          bm25RankToScore,
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
  it.each(
    tokenizers.flatMap((tokenizer) =>
      ["München", "한국어"].flatMap((word) =>
        forms.flatMap((stored) => forms.map((query) => ({ tokenizer, word, stored, query }))),
      ),
    ),
  )(
    "matches $stored $word text with a $query query using $tokenizer",
    async ({ tokenizer, word, stored, query }) => {
      const text = `${word} weather`.normalize(stored);
      await withSearch(
        tokenizer,
        [
          { id: "city", text },
          { id: "control", text: "quartz handbook" },
        ],
        async (search, db) => {
          expect((await search("quartz")).map((hit) => hit.id)).toEqual(["control"]);
          expect(await search("unrecordedword")).toEqual([]);
          expect((await search(word.normalize(query))).map((hit) => hit.id)).toEqual(["city"]);
          expect(
            db.prepare("SELECT text FROM memory_index_chunks WHERE id = 'city'").get(),
          ).toEqual({ text });
        },
      );
    },
  );

  it("preserves a decomposed Korean round trip with unicode61", async () => {
    const text = "한국".normalize("NFD");
    await withSearch("unicode61", [{ id: "korean", text }], async (search) => {
      expect((await search(text)).map((hit) => hit.id)).toEqual(["korean"]);
    });
  });

  it.each(tokenizers)("keeps AND semantics for mixed-form words with %s", async (tokenizer) => {
    await withSearch(
      tokenizer,
      [
        { id: "both", text: `München ${"caféteria".normalize("NFD")}` },
        { id: "city", text: "München weather" },
        { id: "lunch", text: "caféteria handbook" },
      ],
      async (search) => {
        for (const form of forms) {
          expect((await search("München caféteria".normalize(form))).map((hit) => hit.id)).toEqual([
            "both",
          ]);
        }
        expect(await search("München unrecordedword")).toEqual([]);
      },
    );
  });

  it("keeps short canonical trigram terms in substring fallback", async () => {
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

  it.each(tokenizers)(
    "preserves scoped ranked limits for canonical %s queries",
    async (tokenizer) => {
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

  it("preserves whole Unicode words in MATCH-error fallback", async () => {
    await withSearch(
      "unicode61",
      [
        { id: "city", text: "München weather" },
        { id: "split", text: "Mu nchen weather" },
      ],
      async (search) => {
        const hits = await search("München".normalize("NFD"), {
          buildFtsQuery: () => "BROKEN <<<",
        });
        expect(hits.map((hit) => hit.id)).toEqual(["city"]);
        expect(hits[0]?.textScore).toBe(0);
      },
    );
  });
});
