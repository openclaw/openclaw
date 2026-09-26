export const anthropicServerSideFallbackCases = [
  { id: "claude-fable-5", name: "Claude Fable 5" },
  { id: "claude-opus-5", name: "Claude Opus 5" },
  {
    id: "claude-opus-5-5",
    name: "Opus 5.5 with model betas",
    headers: { "Anthropic-Beta": "files-api-2025-04-14" },
    customBeta: true,
  },
  {
    id: "claude-opus-5-5",
    name: "Opus 5.5 with request betas",
    optionHeaders: { "anthropic-beta": "files-api-2025-04-14" },
    customBeta: true,
  },
];
