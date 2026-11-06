import { DatabaseSync } from "node:sqlite";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it } from "vitest";
import { writeMemoryChunks } from "./manager-chunk-writer.js";
import { searchKeyword } from "./manager-search.js";
import { insertKeywordFixture } from "./manager-search.test-support.js";
import { hasTrigramTokenizerForTests } from "./unicode-query.test-support.js";

type Document = { id: string; text: string };
type SearchOptions = Partial<
  Pick<Parameters<typeof searchKeyword>[0], "limit" | "sourceFilter" | "matchAny">
>;

const hasTrigram = hasTrigramTokenizerForTests();

async function withSearch(
  documents: Document[],
  run: (
    search: (query: string, options?: SearchOptions) => ReturnType<typeof searchKeyword>,
    db: DatabaseSync,
  ) => Promise<void>,
  options: { cjkBigram?: boolean } = {},
) {
  const db = new DatabaseSync(":memory:");
  try {
    const schema = ensureMemoryIndexSchema({
      db,
      cacheEnabled: false,
      ftsEnabled: true,
      ftsTokenizer: "trigram",
      cjkBigramFts: options.cjkBigram === true,
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
    // The companion index is derived from the canonical chunks, so a second
    // admit rebuilds it once the fixtures exist.
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: false,
      ftsEnabled: true,
      ftsTokenizer: "trigram",
      cjkBigramFts: options.cjkBigram === true,
    });
    await run(
      (query, searchOptions = {}) =>
        searchKeyword({
          db,
          ftsTable: "memory_index_chunks_fts",
          cjkBigramTable: options.cjkBigram === true ? "memory_index_chunks_cjk_fts" : undefined,
          ftsTokenizer: "trigram",
          query,
          limit: 10,
          snippetMaxChars: 200,
          sourceFilter: { sql: "", params: [] },
          ...searchOptions,
        }),
      db,
    );
  } finally {
    db.close();
  }
}

describe("memory keyword search CJK bigram companion index", () => {
  it.skipIf(!hasTrigram)("ranks a two-character Han query with BM25", async () => {
    await withSearch(
      [
        { id: "dense", text: "配置 配置 設定" },
        { id: "sparse", text: "配置 說明" },
        { id: "control", text: "quartz handbook" },
      ],
      async (search) => {
        const hits = await search("配置");
        expect(hits.map((hit) => hit.id)).toEqual(["dense", "sparse"]);
        expect(hits[0]?.textScore).toBeGreaterThan(0);
        expect(hits[1]?.textScore).toBeGreaterThan(0);
        expect(hits[0]?.textScore).toBeGreaterThan(hits[1]?.textScore ?? 0);
      },
      { cjkBigram: true },
    );
  });

  it.skipIf(!hasTrigram)(
    "recalls a two-character Han query that trigram cannot match",
    async () => {
      await withSearch(
        [
          { id: "han", text: "記憶體設定" },
          { id: "control", text: "quartz handbook" },
        ],
        async (search, db) => {
          const trigramHits = db
            .prepare(
              "SELECT count(*) AS count FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ?",
            )
            .get('"設定"') as { count: number };
          expect(trigramHits.count).toBe(0);
          const hits = await search("設定");
          expect(hits.map((hit) => hit.id)).toEqual(["han"]);
          expect(hits[0]?.textScore).toBeGreaterThan(0);
        },
        { cjkBigram: true },
      );
    },
  );

  it.skipIf(!hasTrigram)("keeps three-character Han queries on the trigram leg", async () => {
    await withSearch(
      [
        { id: "han", text: "記憶體設定" },
        { id: "control", text: "quartz handbook" },
      ],
      async (search) => {
        const hits = await search("記憶體");
        expect(hits.map((hit) => hit.id)).toEqual(["han"]);
        expect(hits[0]?.textScore).toBeGreaterThan(0);
      },
      { cjkBigram: true },
    );
  });

  it.skipIf(!hasTrigram)("keeps ASCII queries on the trigram leg", async () => {
    await withSearch(
      [
        { id: "latin", text: "quartz handbook" },
        { id: "han", text: "記憶體設定" },
      ],
      async (search) => {
        const hits = await search("quartz");
        expect(hits.map((hit) => hit.id)).toEqual(["latin"]);
        expect(hits[0]?.textScore).toBeGreaterThan(0);
      },
      { cjkBigram: true },
    );
  });

  it.skipIf(!hasTrigram)("keeps single-character Han queries unranked", async () => {
    await withSearch(
      [
        { id: "han", text: "記憶體設定" },
        { id: "control", text: "quartz handbook" },
      ],
      async (search) => {
        const hits = await search("記");
        expect(hits.map((hit) => hit.id)).toEqual(["han"]);
        expect(hits[0]?.textScore).toBe(0);
      },
      { cjkBigram: true },
    );
  });

  it.skipIf(!hasTrigram)(
    "falls back to the substring plan without the companion index",
    async () => {
      await withSearch(
        [
          { id: "han", text: "記憶體設定" },
          { id: "control", text: "quartz handbook" },
        ],
        async (search) => {
          const hits = await search("設定");
          expect(hits.map((hit) => hit.id)).toEqual(["han"]);
          expect(hits[0]?.textScore).toBe(0);
        },
      );
    },
  );

  it.skipIf(!hasTrigram)("keeps the companion index aligned with the chunk writer", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      ensureMemoryIndexSchema({
        db,
        cacheEnabled: false,
        ftsEnabled: true,
        ftsTokenizer: "trigram",
        cjkBigramFts: true,
      });
      writeMemoryChunks(db, [
        {
          id: "written-chunk",
          chunk: {
            text: "記憶體設定",
            startLine: 1,
            endLine: 1,
            hash: "hash",
            importance: null,
            triggers: null,
            projectKey: null,
          },
          embedding: [],
          context: {
            path: "memory/written.md",
            source: "memory",
            model: "fts-only",
            now: 1,
          },
        },
      ]);
      const companionRows = db
        .prepare("SELECT count(*) AS count FROM memory_index_chunks_cjk_fts")
        .get() as { count: number };
      expect(companionRows.count).toBe(1);
      const hits = await searchKeyword({
        db,
        ftsTable: "memory_index_chunks_fts",
        cjkBigramTable: "memory_index_chunks_cjk_fts",
        ftsTokenizer: "trigram",
        query: "設定",
        limit: 10,
        snippetMaxChars: 200,
        sourceFilter: { sql: "", params: [] },
      });
      expect(hits.map((hit) => hit.id)).toEqual(["written-chunk"]);
      expect(hits[0]?.textScore).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it.skipIf(!hasTrigram)("recovers mixed Han and short terms under matchAny", async () => {
    await withSearch(
      [
        { id: "han-only", text: "系統設定說明" },
        { id: "ascii-only", text: "general AI overview" },
        { id: "both", text: "系統設定與 AI 工具" },
        { id: "neither", text: "completely unrelated note" },
      ],
      async (search) => {
        const hits = await search("設定 AI", { matchAny: true });
        const ids = hits.map((hit) => hit.id).toSorted();
        expect(ids).toEqual(["ascii-only", "both", "han-only"]);
        const hanHit = hits.find((h) => h.id === "han-only");
        expect(hanHit?.textScore).toBeGreaterThan(0);
      },
      { cjkBigram: true },
    );
  });

  it.skipIf(!hasTrigram)(
    "drops the companion index when the option transitions to off",
    async () => {
      await withSearch(
        [{ id: "han", text: "記憶體設定" }],
        async (_search, db) => {
          const presentBefore = db
            .prepare("SELECT 1 AS ok FROM sqlite_schema WHERE type = 'table' AND name = ?")
            .get("memory_index_chunks_cjk_fts");
          expect(presentBefore).toEqual({ ok: 1 });

          ensureMemoryIndexSchema({
            db,
            cacheEnabled: false,
            ftsEnabled: true,
            ftsTokenizer: "trigram",
            cjkBigramFts: false,
          });

          const presentAfter = db
            .prepare("SELECT 1 AS ok FROM sqlite_schema WHERE type = 'table' AND name = ?")
            .get("memory_index_chunks_cjk_fts");
          expect(presentAfter).toBeUndefined();
        },
        { cjkBigram: true },
      );
    },
  );
});
