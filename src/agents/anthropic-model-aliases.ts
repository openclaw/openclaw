/**
 * Anthropic model id short aliases (no imports — safe to load before heavy provider graphs).
 * Used by parseModelRef / applyContextPruningDefaults; must not participate in circular init.
 */
export const ANTHROPIC_MODEL_ALIASES: Record<string, string> = {
  "opus-4.6": "claude-opus-4-6",
  "opus-4.5": "claude-opus-4-5",
  "sonnet-4.6": "claude-sonnet-4-6",
  "sonnet-4.5": "claude-sonnet-4-5",
};
