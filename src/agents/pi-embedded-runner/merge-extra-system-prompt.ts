/**
 * Merges an existing `extraSystemPrompt` with the user-configured
 * `systemPromptSuffix`. Returns `undefined` when both inputs are absent.
 */
export function mergeExtraSystemPrompt(
  extraSystemPrompt: string | undefined,
  suffix: string | undefined,
): string | undefined {
  const parts = [extraSystemPrompt, suffix].filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
