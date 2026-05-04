const DEFAULT_ONCHAR_PREFIXES = [">", "!"];

export function resolveOncharPrefixes(prefixes: string[] | undefined): string[] {
  const cleaned: string[] = [];
  for (const entry of prefixes ?? []) {
    const prefix = entry.trim();
    if (prefix) {
      cleaned.push(prefix);
    }
  }
  if (!prefixes) {
    return DEFAULT_ONCHAR_PREFIXES;
  }
  return cleaned.length > 0 ? cleaned : DEFAULT_ONCHAR_PREFIXES;
}

export function stripOncharPrefix(
  text: string,
  prefixes: string[],
): { triggered: boolean; stripped: string } {
  const trimmed = text.trimStart();
  for (const prefix of prefixes) {
    if (!prefix) {
      continue;
    }
    if (trimmed.startsWith(prefix)) {
      return {
        triggered: true,
        stripped: trimmed.slice(prefix.length).trimStart(),
      };
    }
  }
  return { triggered: false, stripped: text };
}
