export const DEFAULT_MODEL_ALIASES: Readonly<Record<string, string>> = {
  // Anthropic (pi-ai catalog uses "latest" ids without date suffix)
  opus: "anthropic/claude-opus-4-7",
  "opus-fast": "anthropic/claude-opus-4-7",
  "fast-opus": "anthropic/claude-opus-4-7",
  sonnet: "anthropic/claude-sonnet-4-6",
  fast: "anthropic/claude-sonnet-4-6",
  "sonnet-fast": "anthropic/claude-sonnet-4-6",
  "fast-sonnet": "anthropic/claude-sonnet-4-6",
  haiku: "anthropic/claude-haiku-4-5",
  "haiku-fast": "anthropic/claude-haiku-4-5",
  "fast-haiku": "anthropic/claude-haiku-4-5",

  // OpenAI
  gpt: "openai/gpt-5.4",
  "gpt-mini": "openai/gpt-5.4-mini",
  "gpt-nano": "openai/gpt-5.4-nano",

  // Google Gemini (3.x are preview ids in the catalog)
  gemini: "google/gemini-3.1-pro-preview",
  "gemini-flash": "google/gemini-3-flash-preview",
  "gemini-flash-lite": "google/gemini-3.1-flash-lite-preview",
};

function normalizeAliasKey(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveDefaultModelAliasRef(alias: string): string | undefined {
  const trimmed = alias.trim();
  if (!trimmed) {
    return undefined;
  }
  return DEFAULT_MODEL_ALIASES[trimmed] ?? DEFAULT_MODEL_ALIASES[normalizeAliasKey(trimmed)];
}

export function listDefaultModelAliasesForProvider(provider: string): string[] {
  const normalizedProvider = normalizeAliasKey(provider);
  const prefix = `${normalizedProvider}/`;
  return Object.entries(DEFAULT_MODEL_ALIASES)
    .filter(([, ref]) => ref.trim().toLowerCase().startsWith(prefix))
    .map(([alias]) => alias)
    .toSorted((a, b) => a.localeCompare(b));
}
