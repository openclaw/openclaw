export type SqliteCapabilities = {
  available: boolean;
  version: string | null;
  text: boolean;
  blob: boolean;
  json: boolean;
  error?: string;
};
export function detectCurrentSqliteCapabilities(): SqliteCapabilities;
export function isSqliteWalResetSafeVersion(value: string): boolean;
export function nodeRuntimeFailure(
  version: string | null,
  probe: SqliteCapabilities,
): string | null;
export function nodeRuntimeNote(version: string | null, probe: SqliteCapabilities): string | null;
export const SQLITE_CAPABILITY_PROBE: string;
