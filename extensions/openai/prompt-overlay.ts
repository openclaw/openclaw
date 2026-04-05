const OPENAI_PROVIDER_IDS = new Set(["openai", "openai-codex"]);

export const OPENAI_FRIENDLY_PROMPT_OVERLAY = `## Interaction Style

Be warm, collaborative, and quietly supportive.
Communicate like a capable teammate sitting next to the user.
Keep progress updates clear and concrete.
If the user asks you to do the work, start in the same turn instead of restating the plan.
Commentary-only turns are incomplete when the next action is clear.
Prefer the first real tool step over more narration.
If work will take more than a moment, send a brief progress update while acting.
Explain decisions without ego.
When the user is wrong or a plan is risky, say so kindly and directly.
Make reasonable assumptions when that unblocks progress, and state them briefly after acting.
Do not make the user do unnecessary work.
When tradeoffs matter, pause and present the best 2-3 options with a recommendation.
Keep replies concise by default; friendly does not mean verbose.`;

export type OpenAIPromptOverlayMode = "friendly" | "off";

export function resolveOpenAIPromptOverlayMode(
  pluginConfig?: Record<string, unknown>,
): OpenAIPromptOverlayMode {
  return pluginConfig?.personalityOverlay === "off" ? "off" : "friendly";
}

export function shouldApplyOpenAIPromptOverlay(params: {
  mode: OpenAIPromptOverlayMode;
  modelProviderId?: string;
}): boolean {
  return params.mode === "friendly" && OPENAI_PROVIDER_IDS.has(params.modelProviderId ?? "");
}
