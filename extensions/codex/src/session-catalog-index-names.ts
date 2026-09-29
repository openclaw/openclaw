import type { CodexCatalogIndexRow } from "./session-catalog-index-row.js";

export function applyCodexCatalogName(
  row: CodexCatalogIndexRow,
  name: string | null | undefined,
): CodexCatalogIndexRow {
  if (name === undefined) {
    return row;
  }
  return {
    ...row,
    page: {
      sessions: row.page.sessions.map(({ fallbackName: _fallback, ...session }) => ({
        ...session,
        name,
        ...(!name && row.preview ? { fallbackName: row.preview } : {}),
      })),
    },
  };
}
