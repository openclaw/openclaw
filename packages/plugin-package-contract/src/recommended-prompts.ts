/** Maximum number of author-written starter prompts advertised by a plugin. */
export const MAX_PLUGIN_RECOMMENDED_PROMPTS = 3;

/** Normalize optional display/insert text without rewriting or truncating author content. */
export function validatePluginRecommendedPrompts(
  value: unknown,
): { ok: true; recommendedPrompts?: string[] } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true };
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: "must be an array" };
  }
  if (value.length > MAX_PLUGIN_RECOMMENDED_PROMPTS) {
    return { ok: false, error: `must contain at most ${MAX_PLUGIN_RECOMMENDED_PROMPTS} entries` };
  }
  const recommendedPrompts: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      return { ok: false, error: "entries must be non-empty strings" };
    }
    recommendedPrompts.push(entry.trim());
  }
  return { ok: true, recommendedPrompts };
}
