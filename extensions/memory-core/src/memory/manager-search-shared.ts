import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export type SearchRowResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: MemorySource;
};

export function resolveSnippetProjection(column: "text" | "c.text", snippetMaxChars: number) {
  const snippetByteLimit =
    Number.isSafeInteger(snippetMaxChars) && snippetMaxChars > 0 ? snippetMaxChars * 4 : undefined;
  // Byte prefixes preserve NUL in UTF-8 and UTF-16 databases. Four bytes per
  // UTF-16 unit leave final truncation to truncateUtf16Safe. SQLite returns
  // NULL for an empty BLOB substring, so retain the original empty text.
  return {
    sql:
      snippetByteLimit === undefined
        ? column
        : `COALESCE(CAST(substr(CAST(${column} AS BLOB), 1, ?) AS TEXT), ${column})`,
    params: snippetByteLimit === undefined ? [] : [snippetByteLimit],
  };
}
