// Defaults for agent metadata when upstream does not supply them.
// Model id uses pi-ai's built-in Anthropic catalog.
export const DEFAULT_PROVIDER = "qwen-portal";
export const DEFAULT_MODEL = "coder-model";
// Context window: Qwen3 Coder supports 128k tokens.
export const DEFAULT_CONTEXT_TOKENS = 128_000;
