import { resolveLanguage } from "@pierre/diffs";
import type { SupportedLanguages } from "@pierre/diffs";

const PASSTHROUGH_LANGUAGE_HINTS = new Set<SupportedLanguages>(["ansi", "text"]);

export async function normalizeSupportedLanguageHint(
  value?: string,
): Promise<SupportedLanguages | undefined> {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (PASSTHROUGH_LANGUAGE_HINTS.has(normalized as SupportedLanguages)) {
    return normalized as SupportedLanguages;
  }
  try {
    await resolveLanguage(normalized as Exclude<SupportedLanguages, "text" | "ansi">);
    return normalized as SupportedLanguages;
  } catch {
    return undefined;
  }
}

export async function filterSupportedLanguageHints(
  values: Iterable<string>,
): Promise<SupportedLanguages[]> {
  const supported = new Set<SupportedLanguages>();
  for (const value of values) {
    const normalized = await normalizeSupportedLanguageHint(value);
    if (!normalized) {
      continue;
    }
    supported.add(normalized);
  }
  if (supported.size === 0) {
    supported.add("text");
  }
  return [...supported];
}
