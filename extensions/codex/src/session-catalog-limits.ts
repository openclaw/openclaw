// Match the existing Codex managed-thread retention ceiling.
export const CODEX_CATALOG_MAX_ROWS = 20_000;
export const CODEX_CATALOG_MAX_STATE_KEY_BYTES = 512;

/** Preserve UTF-16 code units without retaining an oversized source string. */
export function detachCodexCatalogString(value: string): string {
  return Buffer.from(value, "utf16le").toString("utf16le");
}
