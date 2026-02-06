// Defaults for agent metadata when upstream does not supply them.
// Local-first: default to Ollama for local operation, but prefer Moonshot when API key is present.

// Static fallback constants (used when no cloud provider is configured)
export const DEFAULT_PROVIDER = "ollama";
export const DEFAULT_MODEL = "llama3:chat";

// CRITICAL: Minimum context window required by embedded agent is 16000 tokens.
// Any value below this causes "blocked model (context window too small)" errors.
// Default to 32768 which is safe for llama3.1 and satisfies minimum requirements.
// Provider-specific context windows are set during discovery (see local-provider-discovery.ts).
export const DEFAULT_CONTEXT_TOKENS = 32768;

// Minimum context window required for embedded agent to function.
// This is enforced at startup validation and model discovery.
export const MINIMUM_CONTEXT_TOKENS = 16000;

// Moonshot (Kimi) defaults - preferred when MOONSHOT_API_KEY is present
// Model ID must match MOONSHOT_DEFAULT_MODEL_ID in src/commands/onboard-auth.models.ts
const MOONSHOT_PROVIDER = "moonshot";
const MOONSHOT_MODEL = "kimi-k2-0905-preview";
const MOONSHOT_CONTEXT_TOKENS = 256000;

/**
 * Resolve the default provider based on available API keys.
 * Priority: MOONSHOT_API_KEY (if present) > ollama (local-first fallback)
 *
 * This enables Moonshot-first dev experience when configured, while
 * preserving local-first behavior for users without cloud API keys.
 */
export function resolveDefaultProvider(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MOONSHOT_API_KEY?.trim()) {
    return MOONSHOT_PROVIDER;
  }
  return DEFAULT_PROVIDER;
}

/**
 * Resolve the default model for a given provider.
 */
export function resolveDefaultModel(provider: string): string {
  if (provider === MOONSHOT_PROVIDER) return MOONSHOT_MODEL;
  return DEFAULT_MODEL;
}

/**
 * Resolve the default context tokens for a given provider.
 * Note: This is informational; actual context comes from model catalog.
 */
export function resolveDefaultContextTokens(provider: string): number {
  if (provider === MOONSHOT_PROVIDER) return MOONSHOT_CONTEXT_TOKENS;
  return DEFAULT_CONTEXT_TOKENS;
}
