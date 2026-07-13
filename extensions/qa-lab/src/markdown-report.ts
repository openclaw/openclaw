// Qa Lab plugin module implements markdown report rendering helpers.

export function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/\|/gu, "\\|").replace(/\s+/gu, " ").trim();
}
