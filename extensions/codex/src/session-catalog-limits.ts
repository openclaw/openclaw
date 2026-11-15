// Match the existing Codex managed-thread retention ceiling.
export const CODEX_CATALOG_MAX_ROWS = 20_000;
export const CODEX_CATALOG_MAX_STATE_KEY_BYTES = 512;
/** Fail-soft budget so one slow host cannot stall the catalog list. */
export const CODEX_CATALOG_HOST_RESPONSE_TIMEOUT_MS = 8_000;

/** Preserve UTF-16 code units without retaining an oversized source string. */
export function detachCodexCatalogString(value: string): string {
  return Buffer.from(value, "utf16le").toString("utf16le");
}

export function rememberCodexCatalogCursor(cursors: Set<string>, cursor: string): void {
  cursors.add(cursor);
  if (cursors.size > CODEX_CATALOG_MAX_ROWS) {
    cursors.delete(cursors.values().next().value!);
  }
}
