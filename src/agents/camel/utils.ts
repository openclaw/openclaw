export function normalizePatternValue(value: string): string {
  return value.trim().toLowerCase();
}

export function matchPattern(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) {
    return normalizePatternValue(pattern) === normalizePatternValue(value);
  }
  const escaped = pattern
    .split("*")
    .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

export function patternMatch(pattern: string, value: string): boolean {
  return matchPattern(pattern, value);
}
