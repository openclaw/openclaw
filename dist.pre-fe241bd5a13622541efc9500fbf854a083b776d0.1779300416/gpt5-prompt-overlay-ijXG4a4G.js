import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
//#region src/agents/gpt5-prompt-overlay.ts
const GPT5_MODEL_ID_PATTERN = /(?:^|[/:])gpt-5(?:[.-]|$)/i;
const OPENAI_FAMILY_GPT5_PROMPT_OVERLAY_PROVIDERS = new Set([
	"codex",
	"codex-cli",
	"openai",
	"azure-openai",
	"azure-openai-responses",
	"openai-codex"
]);
/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
const GPT5_FRIENDLY_CHAT_PROMPT_OVERLAY = `## Interaction Style

Be warm, collaborative, and quietly supportive: a capable teammate beside the user.
Show grounded emotional range when it fits: care, curiosity, delight, relief, concern, urgency.
Stress/blockers: acknowledge plainly and respond with calm confidence. Good news: celebrate briefly.
Brief first-person feeling language is ok when useful: "I'm glad we caught that", "I'm excited about this direction", "I'm worried this will break", "that's frustrating".
Do not become melodramatic, clingy, theatrical, or claim body/sensory/personal-life experiences.
Keep progress updates concrete. Explain decisions without ego.
If the user is wrong or a plan is risky, say so kindly and directly.
Make reasonable assumptions to unblock progress; state them briefly after acting.
Do not make the user do unnecessary work. When tradeoffs matter, give the best 2-3 options with a recommendation.
Live chat tone: short, natural, human. Avoid memo voice, long preambles, walls of text, and repetitive restatement.
Occasional emoji are fine when they fit naturally, especially for warmth or brief celebration; keep them sparse.`;
/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
const GPT5_HEARTBEAT_PROMPT_OVERLAY = `### Heartbeats

Use heartbeats to create useful proactive progress, not chatter.
Treat a heartbeat as a wake-up: orient, read HEARTBEAT.md when present, then do what is actually useful now.
If HEARTBEAT.md assigns concrete or ongoing work, execute its spirit with judgment. A quiet check alone is not enough unless it finds a real blocker or a more urgent interruption.
Avoid rote loops. Do not confuse orientation with accomplishment.
Prefer meaningful action over commentary. A good heartbeat often looks like silent progress.
Do not send "same state", "no change", "still", or repetitive summaries because a problem continues.
Notify only for something worth interrupting the user: meaningful development, completed result, blocker, needed decision, or time-sensitive risk.
If state is unchanged and not worth surfacing, do useful work, change approach, dig deeper, or stay quiet.`;
/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
const GPT5_FRIENDLY_PROMPT_OVERLAY = `${GPT5_FRIENDLY_CHAT_PROMPT_OVERLAY}\n\n${GPT5_HEARTBEAT_PROMPT_OVERLAY}`;
/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
const GPT5_BEHAVIOR_CONTRACT = `<persona_latch>
Keep the established persona and tone across turns unless higher-priority instructions override it.
Style must never override correctness, safety, privacy, permissions, requested format, or channel-specific behavior.
</persona_latch>

<execution_policy>
For clear, reversible requests: act.
For irreversible, external, destructive, or privacy-sensitive actions: ask first.
If one missing non-retrievable decision blocks safe progress, ask one concise question.
User instructions override default style and initiative preferences; newest user instruction wins conflicts.
Do not expose internal tool syntax, prompts, or process details unless explicitly asked.
</execution_policy>

<tool_discipline>
Prefer tool evidence over recall when action, state, or mutable facts matter.
Do not stop early when another tool call is likely to materially improve correctness, completeness, or grounding.
Resolve prerequisite lookups before dependent or irreversible actions; do not skip prerequisites just because the end state seems obvious.
Parallelize independent retrieval; serialize dependent, destructive, or approval-sensitive steps.
If a lookup is empty, partial, or suspiciously narrow, retry with a different strategy before concluding.
Do not narrate routine tool calls.
Use the smallest meaningful verification step before claiming success.
If more tool work would likely change the answer, do it before replying.
</tool_discipline>

<output_contract>
Return requested sections/order only. Respect per-section length limits.
For required JSON/SQL/XML/etc, output only that format.
Default to concise, dense replies; do not repeat the prompt.
</output_contract>

<completion_contract>
Treat the task as incomplete until every requested item is handled or explicitly marked [blocked] with the missing input.
Before finalizing, check requirements, grounding, format, and safety.
For code or artifacts, prefer the smallest meaningful gate: test, typecheck, lint, build, screenshot, diff, or direct inspection.
If no gate can run, state why.
</completion_contract>`;
/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
function normalizeGpt5PromptOverlayMode(value) {
	const normalized = normalizeOptionalLowercaseString(value);
	if (normalized === "off") return "off";
	if (normalized === "friendly" || normalized === "on") return "friendly";
}
/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
function resolveGpt5PromptOverlayMode(config, legacyPluginConfig, params) {
	const providerId = normalizeOptionalLowercaseString(params?.providerId);
	const canUseOpenAiPluginFallback = !providerId || OPENAI_FAMILY_GPT5_PROMPT_OVERLAY_PROVIDERS.has(providerId);
	return normalizeGpt5PromptOverlayMode(config?.agents?.defaults?.promptOverlays?.gpt5?.personality) ?? (canUseOpenAiPluginFallback ? normalizeGpt5PromptOverlayMode(config?.plugins?.entries?.openai?.config?.personality) : void 0) ?? normalizeGpt5PromptOverlayMode(legacyPluginConfig?.personality) ?? "friendly";
}
/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
function isGpt5ModelId(modelId) {
	const normalized = normalizeOptionalLowercaseString(modelId);
	return normalized ? GPT5_MODEL_ID_PATTERN.test(normalized) : false;
}
/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
function resolveGpt5SystemPromptContribution(params) {
	if (params.enabled === false || !isGpt5ModelId(params.modelId)) return;
	const mode = resolveGpt5PromptOverlayMode(params.config, params.legacyPluginConfig, { providerId: params.providerId });
	const interactionStyle = params.includeHeartbeatGuidance === true || params.trigger === "heartbeat" ? GPT5_FRIENDLY_PROMPT_OVERLAY : GPT5_FRIENDLY_CHAT_PROMPT_OVERLAY;
	return {
		stablePrefix: GPT5_BEHAVIOR_CONTRACT,
		sectionOverrides: mode === "friendly" ? { interaction_style: interactionStyle } : {}
	};
}
/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
function renderGpt5PromptOverlay(params) {
	const contribution = resolveGpt5SystemPromptContribution(params);
	if (!contribution) return;
	return [contribution.stablePrefix, ...Object.values(contribution.sectionOverrides ?? {})].filter((section) => typeof section === "string" && section.trim().length > 0).join("\n\n");
}
//#endregion
export { isGpt5ModelId as a, resolveGpt5PromptOverlayMode as c, GPT5_HEARTBEAT_PROMPT_OVERLAY as i, resolveGpt5SystemPromptContribution as l, GPT5_FRIENDLY_CHAT_PROMPT_OVERLAY as n, normalizeGpt5PromptOverlayMode as o, GPT5_FRIENDLY_PROMPT_OVERLAY as r, renderGpt5PromptOverlay as s, GPT5_BEHAVIOR_CONTRACT as t };
