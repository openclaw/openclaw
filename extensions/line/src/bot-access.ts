export function normalizeLineAllowEntry(value: string | number): string {
  return String(value)
    .trim()
    .replace(/^line:(?:user:)?/i, "");
}
