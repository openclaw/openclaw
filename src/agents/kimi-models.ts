export const KIMI_CODING_DEFAULT_CONTEXT_WINDOW = 262144;
export const KIMI_CODING_DEFAULT_MAX_TOKENS = 32768;

export const KIMI_MODEL_CATALOG = [
  {
    id: "kimi-code",
    name: "Kimi Code",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: KIMI_CODING_DEFAULT_CONTEXT_WINDOW,
    maxTokens: KIMI_CODING_DEFAULT_MAX_TOKENS,
  },
  {
    id: "k2p5",
    name: "Kimi Code (legacy model id)",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: KIMI_CODING_DEFAULT_CONTEXT_WINDOW,
    maxTokens: KIMI_CODING_DEFAULT_MAX_TOKENS,
  },
] as const;

export type KimiCatalogEntry = (typeof KIMI_MODEL_CATALOG)[number];
