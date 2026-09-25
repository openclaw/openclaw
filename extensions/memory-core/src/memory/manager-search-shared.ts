import { truncateUtf16Safe } from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export type MemorySearchRow = {
  id: string;
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  source: MemorySource;
};

export type SearchRowResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: MemorySource;
};

export function projectMemorySearchRow(
  row: MemorySearchRow,
  snippetMaxChars: number,
  score: number,
): SearchRowResult {
  return {
    id: row.id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    score,
    snippet: truncateUtf16Safe(row.text, snippetMaxChars),
    source: row.source,
  };
}

export function buildMemoryModelFilter(column: string, models: string[]): string {
  return models.length === 1
    ? `${column} = ?`
    : `${column} IN (${models.map(() => "?").join(", ")})`;
}

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
