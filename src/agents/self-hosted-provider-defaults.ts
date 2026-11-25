import { DEFAULT_MODEL_MAX_TOKENS } from "./defaults.js";

/**
 * Conservative defaults for self-hosted providers when the model catalog
 * cannot supply pricing or token limits.
 */
/** Default context window used for self-hosted provider catalog entries. */
export const SELF_HOSTED_DEFAULT_CONTEXT_WINDOW = 128000;
/**
 * Default output-token cap for self-hosted provider catalog entries. Callers that know the
 * model's window use `resolveDefaultModelMaxTokens` so small local windows keep input room.
 */
export const SELF_HOSTED_DEFAULT_MAX_TOKENS = DEFAULT_MODEL_MAX_TOKENS;
/** Zero-cost pricing used for self-hosted provider catalog entries. */
export const SELF_HOSTED_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
