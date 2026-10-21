// Memory Core source filtering shared by the manager and subprocess request validation tests.
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export type MemorySourceFilter = {
  sql: string;
  params: MemorySource[];
  excludedSessionPaths?: readonly string[];
};

export function buildMemorySourceFilter(
  alias: string | undefined,
  sources: readonly MemorySource[],
  excludedSessionPaths?: readonly string[],
): MemorySourceFilter {
  const column = alias ? `${alias}.source` : "source";
  const placeholders = sources.map(() => "?").join(", ");
  return {
    sql: sources.length ? ` AND ${column} IN (${placeholders})` : "",
    params: [...sources],
    ...(excludedSessionPaths?.length ? { excludedSessionPaths } : {}),
  };
}

/** Exclude internal transcripts before candidate limits, without consuming one bind per path. */
export function buildSqliteMemorySourceFilter(
  filter: MemorySourceFilter,
  alias?: string,
): { sql: string; params: string[] } {
  if (!filter.excludedSessionPaths?.length) {
    return filter;
  }
  const source = alias ? `${alias}.source` : "source";
  const path = alias ? `${alias}.path` : "path";
  return {
    sql: `${filter.sql} AND (${source} != 'sessions' OR ${path} NOT IN (SELECT value FROM json_each(?)))`,
    params: [...filter.params, JSON.stringify(filter.excludedSessionPaths)],
  };
}
