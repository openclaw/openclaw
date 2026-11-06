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

export type SearchRowResult = ReturnType<typeof projectMemorySearchRow>;

export function projectMemorySearchRow(
  row: MemorySearchRow,
  snippetMaxChars: number,
  score: number,
) {
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

/** Construct SQL for companion index queries with optional OR recovery. */
export function buildCompanionSearchSql(params: {
  cjkTable: string;
  filter: string;
  sourceFilterSql: string;
  mixedOr: boolean;
}): string {
  if (params.mixedOr) {
    return (
      `WITH hits AS (\n` +
      `  SELECT "rowid" AS chunk_rowid, rank FROM ${params.cjkTable}\n` +
      `   WHERE ${params.cjkTable} MATCH ? AND ${params.cjkTable}.rank MATCH 'bm25()'\n` +
      `), matches AS (\n` +
      `  SELECT c.id, c.path, c.source, c.start_line, c.end_line, c.text, hits.rank AS rank\n` +
      `    FROM hits JOIN memory_index_chunks c ON c.chunk_rowid = hits.chunk_rowid\n` +
      `   WHERE 1=1${params.sourceFilterSql}\n` +
      `   ORDER BY hits.rank ASC\n` +
      `   LIMIT ?\n` +
      `), substrings AS (\n` +
      `  SELECT c.id, c.path, c.source, c.start_line, c.end_line, c.text, NULL AS rank\n` +
      `    FROM memory_index_chunks c\n` +
      `   WHERE 1=1${params.filter}${params.sourceFilterSql}\n` +
      `     AND c.id NOT IN (SELECT id FROM matches)\n` +
      `   LIMIT max(0, ? - (SELECT count(*) FROM matches))\n` +
      `)\n` +
      `SELECT * FROM matches UNION ALL SELECT * FROM substrings\n` +
      `ORDER BY rank ASC NULLS LAST\n` +
      `LIMIT ?`
    );
  }
  return (
    `WITH hits AS (\n` +
    `  SELECT "rowid" AS chunk_rowid, rank FROM ${params.cjkTable}\n` +
    `   WHERE ${params.cjkTable} MATCH ? AND ${params.cjkTable}.rank MATCH 'bm25()'\n` +
    `)\n` +
    `SELECT c.id, c.path, c.source, c.start_line, c.end_line, c.text,\n` +
    `       hits.rank AS rank\n` +
    `  FROM hits JOIN memory_index_chunks c ON c.chunk_rowid = hits.chunk_rowid\n` +
    ` WHERE 1=1${params.filter}${params.sourceFilterSql}\n` +
    ` ORDER BY hits.rank ASC\n` +
    ` LIMIT ?`
  );
}
