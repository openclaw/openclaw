/**
 * Soul reflection sub-turn: deciding *when* to fire, and what prompt to fire with.
 *
 * The runner is expected to:
 *   1. call {@link shouldFireReflection} on each user message
 *   2. if it returns a `ReflectionTrigger`, spawn a sub-turn with the prompt from
 *      {@link buildReflectionPrompt} and the `soul_update` tool
 *   3. emit a forced notice when `soul_update` returns `status: "appended"`
 *
 * This module owns no IO and no model calls — those live in the runner.
 */

export const SIGNAL_KEYWORDS = ["stop", "don't", "dont", "never", "prefer", "no more"] as const;

const SIGNAL_KEYWORD_PATTERN = new RegExp(
  `\\b(?:${SIGNAL_KEYWORDS.map((kw) => kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);

export type SoulReflectionConfig = {
  readonly autoUpdate?: boolean;
};

export type ReflectionTrigger = { readonly kind: "keyword"; readonly matched: string };

export type ShouldFireReflectionInput = {
  readonly userMessage: string;
  readonly config: SoulReflectionConfig | undefined;
};

export function shouldFireReflection(input: ShouldFireReflectionInput): ReflectionTrigger | null {
  if (input.config?.autoUpdate !== true) {
    return null;
  }
  const trimmed = input.userMessage.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const keywordMatch = SIGNAL_KEYWORD_PATTERN.exec(trimmed);
  if (keywordMatch) {
    return { kind: "keyword", matched: keywordMatch[0].toLowerCase() };
  }
  return null;
}

export const REFLECTION_PROMPT = [
  "Reflection sub-turn.",
  "",
  "In recent context, has the user expressed a durable preference, correction, or rule about how you communicate worth persisting to SOUL.md?",
  "",
  'If YES: call the `soul_update` tool with a concise `rule` (≤ 280 chars, imperative voice, no first-person — e.g. "never use em-dashes") and a short `evidence` quote from the user.',
  "If NO:  call `soul_update` with `noop: true`.",
  "",
  "Guidelines:",
  "- Only persist durable rules about communication style, format, tone, or boundaries — not one-off task details.",
  "- Skip rules already implied by your existing SOUL.md.",
  "- Do not write the user's identity, secrets, or contact details.",
].join("\n");

export type BuildReflectionPromptInput = {
  readonly trigger: ReflectionTrigger;
  readonly recentUserMessage: string;
};

export function buildReflectionPrompt(input: BuildReflectionPromptInput): string {
  const triggerLine = `Trigger: signal keyword "${input.trigger.matched}" in latest user message.`;
  return [
    REFLECTION_PROMPT,
    "",
    triggerLine,
    "",
    "Latest user message:",
    input.recentUserMessage.trim(),
  ].join("\n");
}
