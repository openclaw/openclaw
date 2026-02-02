// Defaults for agent metadata when upstream does not supply them.
export const DEFAULT_PROVIDER = "minimax";
export const DEFAULT_MODEL = "MiniMax-M2.1";
// Context window: Opus 4.5 supports ~200k tokens (per pi-ai models.generated.ts).
export const DEFAULT_CONTEXT_TOKENS = 200_000;
