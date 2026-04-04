export function normalizeStructuredPromptSection(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

export function normalizePromptCapabilityIds(capabilities: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const capability of capabilities) {
    const value = normalizeStructuredPromptSection(String(capability ?? "")).toLowerCase();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized.toSorted((left, right) => left.localeCompare(right));
}
