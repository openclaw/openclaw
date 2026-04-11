/**
 * Shared Anthropic constants used by stream-wrappers and bypass-detection.
 */

export const PI_AI_DEFAULT_ANTHROPIC_BETAS = [
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
] as const;

export const PI_AI_OAUTH_ANTHROPIC_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  ...PI_AI_DEFAULT_ANTHROPIC_BETAS,
] as const;

/**
 * Merge anthropic-beta header values, deduplicating entries.
 */
export function mergeAnthropicBetaHeader(
  headers: Record<string, string> | undefined,
  betas: string[],
): Record<string, string> {
  const merged = { ...headers };
  const existingKey = Object.keys(merged).find(
    (key) => key.toLowerCase() === "anthropic-beta",
  );
  const existing = existingKey
    ? merged[existingKey]
        .split(",")
        .map((item: string) => item.trim())
        .filter(Boolean)
    : [];
  const values = Array.from(new Set([...existing, ...betas]));
  const key = existingKey ?? "anthropic-beta";
  merged[key] = values.join(",");
  return merged;
}
