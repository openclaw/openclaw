import { expect, onTestFinished } from "vitest";
import { searchKeyword } from "./manager-search.js";
import { createMemorySearchDb } from "./manager-search.test-support.js";

export function createKeywordSearch(ftsTokenizer: "unicode61" | "trigram" = "unicode61") {
  const { db, schema } = createMemorySearchDb({ ftsTokenizer });
  onTestFinished(() => db.close());
  expect(schema.ftsAvailable, schema.ftsError).toBe(true);
  return {
    db,
    search: (
      query: string,
      options: Partial<Omit<Parameters<typeof searchKeyword>[0], "db" | "query">> = {},
    ) =>
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
  };
}
