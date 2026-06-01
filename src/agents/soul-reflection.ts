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

export const DEFAULT_TURN_INTERVAL = 5;
export const SIGNAL_KEYWORDS = [
  "stop",
  "don't",
  "dont",
  "never",
  "please",
  "prefer",
  "no more",
] as const;

const SIGNAL_KEYWORD_PATTERN = new RegExp(
  `\\b(?:${SIGNAL_KEYWORDS.map((kw) => kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);

export type SoulReflectionConfig = {
  readonly autoUpdate?: boolean;
  readonly reflectionTurnInterval?: number;
};

export type ReflectionTrigger =
  | { readonly kind: "keyword"; readonly matched: string }
  | { readonly kind: "interval"; readonly turnsSinceLast: number };

export type ShouldFireReflectionInput = {
  readonly userMessage: string;
  readonly turnsSinceLast: number;
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
  const interval = resolveTurnInterval(input.config.reflectionTurnInterval);
  if (input.turnsSinceLast >= interval) {
    return { kind: "interval", turnsSinceLast: input.turnsSinceLast };
  }
  return null;
}

export function resolveTurnInterval(configured: number | undefined): number {
  if (typeof configured !== "number" || !Number.isFinite(configured) || configured < 1) {
    return DEFAULT_TURN_INTERVAL;
  }
  return Math.floor(configured);
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
  const triggerLine =
    input.trigger.kind === "keyword"
      ? `Trigger: signal keyword "${input.trigger.matched}" in latest user message.`
      : `Trigger: ${input.trigger.turnsSinceLast} turns since last reflection.`;
  return [
    REFLECTION_PROMPT,
    "",
    triggerLine,
    "",
    "Latest user message:",
    input.recentUserMessage.trim(),
  ].join("\n");
}
