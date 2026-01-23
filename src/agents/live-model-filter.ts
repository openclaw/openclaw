export type ModelRef = {
  provider?: string | null;
  id?: string | null;
};

const ANTHROPIC_PREFIXES = ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"];
const OPENAI_MODELS = ["gpt-5.2", "gpt-5.0"];
const CODEX_MODELS = [
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex-max",
];
const GOOGLE_PREFIXES = ["gemini-3"];
const ZAI_PREFIXES = ["glm-4.7"];
const MINIMAX_PREFIXES = ["minimax-m2.1"];
const XAI_PREFIXES = ["grok-4"];

function matchesPrefix(id: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => id.startsWith(prefix));
}

function matchesExactOrPrefix(id: string, values: string[]): boolean {
  return values.some((value) => id === value || id.startsWith(value));
}

function matchesAny(id: string, values: string[]): boolean {
  return values.some((value) => id.includes(value));
}

export function isModernModelRef(ref: ModelRef): boolean {
  const provider = ref.provider?.trim().toLowerCase() ?? "";
  const id = ref.id?.trim().toLowerCase() ?? "";
  if (!provider || !id) return false;

  if (provider === "anthropic") {
    return matchesPrefix(id, ANTHROPIC_PREFIXES);
  }

  if (provider === "openai") {
    return matchesExactOrPrefix(id, OPENAI_MODELS);
  }

  if (provider === "openai-codex") {
    return matchesExactOrPrefix(id, CODEX_MODELS);
  }

  if (provider === "google" || provider === "google-gemini-cli") {
    return matchesPrefix(id, GOOGLE_PREFIXES);
  }

  if (provider === "google-antigravity") {
    return matchesPrefix(id, GOOGLE_PREFIXES) || matchesPrefix(id, ANTHROPIC_PREFIXES);
  }

  if (provider === "zai") {
    return matchesPrefix(id, ZAI_PREFIXES);
  }

  if (provider === "minimax") {
    return matchesPrefix(id, MINIMAX_PREFIXES);
  }

  if (provider === "xai") {
    return matchesPrefix(id, XAI_PREFIXES);
  }

  if (provider === "opencode" && id.endsWith("-free")) {
    return false;
  }

  if (provider === "openrouter" || provider === "opencode") {
    return matchesAny(id, [
      ...ANTHROPIC_PREFIXES,
      ...OPENAI_MODELS,
      ...CODEX_MODELS,
      ...GOOGLE_PREFIXES,
      ...ZAI_PREFIXES,
      ...MINIMAX_PREFIXES,
      ...XAI_PREFIXES,
    ]);
  }

  return false;
}
