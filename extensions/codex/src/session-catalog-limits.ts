// Match the existing Codex managed-thread retention ceiling.
export const CODEX_CATALOG_MAX_ROWS = 20_000;
export const CODEX_CATALOG_MAX_STATE_KEY_BYTES = 512;
/** Fail-soft budget so one slow host cannot stall the catalog list. */
export const CODEX_CATALOG_HOST_RESPONSE_TIMEOUT_MS = 8_000;
/** Local homes outlast the paired-node budget so native refill can continue. */
export const CODEX_CATALOG_LOCAL_HOST_RESPONSE_TIMEOUT_MS = 20_000;

/** Preserve UTF-16 code units without retaining an oversized source string. */
export function detachCodexCatalogString(value: string): string {
  return Buffer.from(value, "utf16le").toString("utf16le");
}
