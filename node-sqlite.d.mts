import type { SqliteCapabilities } from "./node-sqlite-capabilities.mjs";
export type { SqliteCapabilities } from "./node-sqlite-capabilities.mjs";
export { isSqliteWalResetSafeVersion } from "./node-sqlite-capabilities.mjs";
export type SqliteProbeExecution = "worker" | "current-thread";
export function detectCurrentSqliteCapabilities(options?: {
  execution?: SqliteProbeExecution;
}): Promise<SqliteCapabilities>;
export function nodeRuntimeFailure(
  version: string | null,
  probe: SqliteCapabilities,
): string | null;
