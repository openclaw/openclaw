/** Maximum number of author-written starter prompts advertised by a plugin. */
export const MAX_PLUGIN_RECOMMENDED_PROMPTS = 3;
/** Maximum Unicode code points in each whitespace-normalized starter prompt. */
export const MAX_PLUGIN_RECOMMENDED_PROMPT_LENGTH = 128;

/** Normalize optional display/insert whitespace; reject invalid content without truncation. */
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
    const prompt = entry.replace(/\s+/gu, " ").trim();
    if (Array.from(prompt).length > MAX_PLUGIN_RECOMMENDED_PROMPT_LENGTH) {
      return {
        ok: false,
        error: `entries must be at most ${MAX_PLUGIN_RECOMMENDED_PROMPT_LENGTH} Unicode code points`,
      };
    }
    recommendedPrompts.push(prompt);
  }
  return { ok: true, recommendedPrompts };
}
