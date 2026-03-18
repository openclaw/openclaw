import type { ExecutionKind, SmartHandlerConfig } from "./types.ts";

export interface PhraseMatch {
  readonly phrase: string;
  readonly kind: ExecutionKind;
}

/**
 * Match user message against custom phrases.
 * Returns the matching kind or null if no match.
 * Uses case-insensitive substring matching.
 */
export function matchCustomPhrase(message: string, config: SmartHandlerConfig): PhraseMatch | null {
  const lower = message.toLowerCase().trim();
  for (const entry of config.customPhrases) {
    if (lower.includes(entry.phrase.toLowerCase())) {
      return { phrase: entry.phrase, kind: entry.kind };
    }
  }
  return null;
}
