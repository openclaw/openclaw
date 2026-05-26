import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { o as ModelCompatConfig } from "./types.models-tqxsISRc.js";
import { Dn as ProviderResolveDynamicModelContext, Fn as ProviderSanitizeReplayHistoryContext, Qn as ProviderRuntimeModel, Zn as ProviderThinkingProfile, bn as ProviderReplayPolicy, oi as ProviderSystemPromptContribution, sn as ProviderPlugin, vn as ProviderReasoningOutputMode, xn as ProviderReplayPolicyContext } from "./types-Vx7Jq4_-2.js";
import { Api, Model } from "@earendil-works/pi-ai";
import { AgentMessage } from "@earendil-works/pi-agent-core";

//#region src/plugins/provider-replay-helpers.d.ts
/** @deprecated Provider replay helper; prefer provider-local replay hooks. */
declare function buildOpenAICompatibleReplayPolicy(modelApi: string | null | undefined, options?: {
  sanitizeToolCallIds?: boolean;
  modelId?: string | null;
  dropReasoningFromHistory?: boolean;
}): ProviderReplayPolicy | undefined;
/** @deprecated Anthropic-family provider replay helper; prefer provider-local replay hooks. */
declare function buildStrictAnthropicReplayPolicy(options?: {
  dropThinkingBlocks?: boolean;
  sanitizeToolCallIds?: boolean;
  preserveNativeAnthropicToolUseIds?: boolean;
}): ProviderReplayPolicy;
/** @deprecated Anthropic-family provider replay helper; prefer provider-local replay hooks. */
declare function buildAnthropicReplayPolicyForModel(modelId?: string): ProviderReplayPolicy;
/** @deprecated Anthropic-family provider replay helper; prefer provider-local replay hooks. */
declare function buildNativeAnthropicReplayPolicyForModel(modelId?: string): ProviderReplayPolicy;
/** @deprecated Provider replay helper; prefer provider-local replay hooks. */
declare function buildHybridAnthropicOrOpenAIReplayPolicy(ctx: ProviderReplayPolicyContext, options?: {
  anthropicModelDropThinkingBlocks?: boolean;
}): ProviderReplayPolicy | undefined;
/** @deprecated Google provider replay helper; prefer provider-local replay hooks. */
declare function buildGoogleGeminiReplayPolicy(): ProviderReplayPolicy;
/** @deprecated Google provider replay helper; prefer provider-local replay hooks. */
declare function buildPassthroughGeminiSanitizingReplayPolicy(modelId?: string): ProviderReplayPolicy;
/** @deprecated Google provider replay helper; prefer provider-local replay hooks. */
declare function sanitizeGoogleGeminiReplayHistory(ctx: ProviderSanitizeReplayHistoryContext): AgentMessage[];
/** @deprecated Provider replay helper; prefer provider-local replay hooks. */
declare function resolveTaggedReasoningOutputMode(): ProviderReasoningOutputMode;
//#endregion
//#region src/plugin-sdk/provider-model-id-normalize.d.ts
declare function normalizeGooglePreviewModelId(id: string): string;
declare function normalizeAntigravityPreviewModelId(id: string): string;
//#endregion
//#region src/agents/gpt5-prompt-overlay.d.ts
/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
declare const GPT5_FRIENDLY_CHAT_PROMPT_OVERLAY = "## Interaction Style\n\nBe warm, collaborative, and quietly supportive: a capable teammate beside the user.\nShow grounded emotional range when it fits: care, curiosity, delight, relief, concern, urgency.\nStress/blockers: acknowledge plainly and respond with calm confidence. Good news: celebrate briefly.\nBrief first-person feeling language is ok when useful: \"I'm glad we caught that\", \"I'm excited about this direction\", \"I'm worried this will break\", \"that's frustrating\".\nDo not become melodramatic, clingy, theatrical, or claim body/sensory/personal-life experiences.\nKeep progress updates concrete. Explain decisions without ego.\nIf the user is wrong or a plan is risky, say so kindly and directly.\nMake reasonable assumptions to unblock progress; state them briefly after acting.\nDo not make the user do unnecessary work. When tradeoffs matter, give the best 2-3 options with a recommendation.\nLive chat tone: short, natural, human. Avoid memo voice, long preambles, walls of text, and repetitive restatement.\nOccasional emoji are fine when they fit naturally, especially for warmth or brief celebration; keep them sparse.";
/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
declare const GPT5_HEARTBEAT_PROMPT_OVERLAY = "### Heartbeats\n\nUse heartbeats to create useful proactive progress, not chatter.\nTreat a heartbeat as a wake-up: orient, read HEARTBEAT.md when present, then do what is actually useful now.\nIf HEARTBEAT.md assigns concrete or ongoing work, execute its spirit with judgment. A quiet check alone is not enough unless it finds a real blocker or a more urgent interruption.\nAvoid rote loops. Do not confuse orientation with accomplishment.\nPrefer meaningful action over commentary. A good heartbeat often looks like silent progress.\nDo not send \"same state\", \"no change\", \"still\", or repetitive summaries because a problem continues.\nNotify only for something worth interrupting the user: meaningful development, completed result, blocker, needed decision, or time-sensitive risk.\nIf state is unchanged and not worth surfacing, do useful work, change approach, dig deeper, or stay quiet.";
/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
declare const GPT5_FRIENDLY_PROMPT_OVERLAY = "## Interaction Style\n\nBe warm, collaborative, and quietly supportive: a capable teammate beside the user.\nShow grounded emotional range when it fits: care, curiosity, delight, relief, concern, urgency.\nStress/blockers: acknowledge plainly and respond with calm confidence. Good news: celebrate briefly.\nBrief first-person feeling language is ok when useful: \"I'm glad we caught that\", \"I'm excited about this direction\", \"I'm worried this will break\", \"that's frustrating\".\nDo not become melodramatic, clingy, theatrical, or claim body/sensory/personal-life experiences.\nKeep progress updates concrete. Explain decisions without ego.\nIf the user is wrong or a plan is risky, say so kindly and directly.\nMake reasonable assumptions to unblock progress; state them briefly after acting.\nDo not make the user do unnecessary work. When tradeoffs matter, give the best 2-3 options with a recommendation.\nLive chat tone: short, natural, human. Avoid memo voice, long preambles, walls of text, and repetitive restatement.\nOccasional emoji are fine when they fit naturally, especially for warmth or brief celebration; keep them sparse.\n\n### Heartbeats\n\nUse heartbeats to create useful proactive progress, not chatter.\nTreat a heartbeat as a wake-up: orient, read HEARTBEAT.md when present, then do what is actually useful now.\nIf HEARTBEAT.md assigns concrete or ongoing work, execute its spirit with judgment. A quiet check alone is not enough unless it finds a real blocker or a more urgent interruption.\nAvoid rote loops. Do not confuse orientation with accomplishment.\nPrefer meaningful action over commentary. A good heartbeat often looks like silent progress.\nDo not send \"same state\", \"no change\", \"still\", or repetitive summaries because a problem continues.\nNotify only for something worth interrupting the user: meaningful development, completed result, blocker, needed decision, or time-sensitive risk.\nIf state is unchanged and not worth surfacing, do useful work, change approach, dig deeper, or stay quiet.";
/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
declare const GPT5_BEHAVIOR_CONTRACT = "<persona_latch>\nKeep the established persona and tone across turns unless higher-priority instructions override it.\nStyle must never override correctness, safety, privacy, permissions, requested format, or channel-specific behavior.\n</persona_latch>\n\n<execution_policy>\nFor clear, reversible requests: act.\nFor irreversible, external, destructive, or privacy-sensitive actions: ask first.\nIf one missing non-retrievable decision blocks safe progress, ask one concise question.\nUser instructions override default style and initiative preferences; newest user instruction wins conflicts.\nDo not expose internal tool syntax, prompts, or process details unless explicitly asked.\n</execution_policy>\n\n<tool_discipline>\nPrefer tool evidence over recall when action, state, or mutable facts matter.\nDo not stop early when another tool call is likely to materially improve correctness, completeness, or grounding.\nResolve prerequisite lookups before dependent or irreversible actions; do not skip prerequisites just because the end state seems obvious.\nParallelize independent retrieval; serialize dependent, destructive, or approval-sensitive steps.\nIf a lookup is empty, partial, or suspiciously narrow, retry with a different strategy before concluding.\nDo not narrate routine tool calls.\nUse the smallest meaningful verification step before claiming success.\nIf more tool work would likely change the answer, do it before replying.\n</tool_discipline>\n\n<output_contract>\nReturn requested sections/order only. Respect per-section length limits.\nFor required JSON/SQL/XML/etc, output only that format.\nDefault to concise, dense replies; do not repeat the prompt.\n</output_contract>\n\n<completion_contract>\nTreat the task as incomplete until every requested item is handled or explicitly marked [blocked] with the missing input.\nBefore finalizing, check requirements, grounding, format, and safety.\nFor code or artifacts, prefer the smallest meaningful gate: test, typecheck, lint, build, screenshot, diff, or direct inspection.\nIf no gate can run, state why.\n</completion_contract>";
/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
type Gpt5PromptOverlayMode = "friendly" | "off";
/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
declare function normalizeGpt5PromptOverlayMode(value: unknown): Gpt5PromptOverlayMode | undefined;
/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
declare function resolveGpt5PromptOverlayMode(config?: OpenClawConfig, legacyPluginConfig?: Record<string, unknown>, params?: {
  providerId?: string;
}): Gpt5PromptOverlayMode;
/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
declare function isGpt5ModelId(modelId?: string): boolean;
/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
declare function resolveGpt5SystemPromptContribution(params: {
  config?: OpenClawConfig;
  providerId?: string;
  modelId?: string;
  legacyPluginConfig?: Record<string, unknown>;
  enabled?: boolean;
  trigger?: "cron" | "heartbeat" | "manual" | "memory" | "overflow" | "user";
  includeHeartbeatGuidance?: boolean;
}): ProviderSystemPromptContribution | undefined;
/** @deprecated OpenAI/Codex provider-owned prompt overlay helper; do not use from third-party plugins. */
declare function renderGpt5PromptOverlay(params: {
  config?: OpenClawConfig;
  providerId?: string;
  modelId?: string;
  legacyPluginConfig?: Record<string, unknown>;
  enabled?: boolean;
}): string | undefined;
//#endregion
//#region src/plugins/provider-model-compat.d.ts
/** @deprecated Provider-owned model compat helper; do not use from third-party plugins. */
declare function applyModelCompatPatch<T extends {
  compat?: ModelCompatConfig;
}>(model: T, patch: Partial<ModelCompatConfig> & Record<string, unknown>): T;
declare function hasToolSchemaProfile(modelOrCompat: {
  compat?: unknown;
} | ModelCompatConfig | undefined, profile: string): boolean;
declare function hasNativeWebSearchTool(modelOrCompat: {
  compat?: unknown;
} | ModelCompatConfig | undefined): boolean;
declare function resolveToolCallArgumentsEncoding(modelOrCompat: {
  compat?: unknown;
} | ModelCompatConfig | undefined): ModelCompatConfig["toolCallArgumentsEncoding"] | undefined;
declare function resolveUnsupportedToolSchemaKeywords(modelOrCompat: {
  compat?: unknown;
} | ModelCompatConfig | undefined): ReadonlySet<string>;
declare function normalizeModelCompat(model: Model<Api>): Model<Api>;
//#endregion
//#region src/plugins/provider-model-helpers.d.ts
declare function matchesExactOrPrefix(id: string, values: readonly string[]): boolean;
declare function cloneFirstTemplateModel(params: {
  providerId: string;
  modelId: string;
  templateIds: readonly string[];
  ctx: ProviderResolveDynamicModelContext;
  patch?: Partial<ProviderRuntimeModel>;
}): ProviderRuntimeModel | undefined;
//#endregion
//#region src/plugin-sdk/provider-model-shared.d.ts
/** @deprecated Proxy provider-owned model helper; do not use from third-party plugins. */
declare function isProxyReasoningUnsupportedModelHint(modelId: string): boolean;
/** @deprecated Anthropic provider-owned model helper; do not use from third-party plugins. */
declare function isClaudeAdaptiveThinkingDefaultModelId(modelId: string): boolean;
/** @deprecated Anthropic provider-owned model helper; do not use from third-party plugins. */
declare function resolveClaudeThinkingProfile(modelId: string): ProviderThinkingProfile;
type ProviderReplayFamily = "openai-compatible" | "anthropic-by-model" | "native-anthropic-by-model" | "google-gemini" | "passthrough-gemini" | "hybrid-anthropic-openai";
type ProviderReplayFamilyHooks = Pick<ProviderPlugin, "buildReplayPolicy" | "sanitizeReplayHistory" | "resolveReasoningOutputMode">;
type BuildProviderReplayFamilyHooksOptions = {
  family: "openai-compatible";
  sanitizeToolCallIds?: boolean;
  dropReasoningFromHistory?: boolean;
} | {
  family: "anthropic-by-model";
} | {
  family: "native-anthropic-by-model";
} | {
  family: "google-gemini";
} | {
  family: "passthrough-gemini";
} | {
  family: "hybrid-anthropic-openai";
  anthropicModelDropThinkingBlocks?: boolean;
};
declare function buildProviderReplayFamilyHooks(options: BuildProviderReplayFamilyHooksOptions): ProviderReplayFamilyHooks;
/** @deprecated Provider-owned replay hook shortcut; use local provider hooks instead. */
declare const OPENAI_COMPATIBLE_REPLAY_HOOKS: ProviderReplayFamilyHooks;
/** @deprecated Anthropic provider-owned replay hook shortcut; use local provider hooks instead. */
declare const ANTHROPIC_BY_MODEL_REPLAY_HOOKS: ProviderReplayFamilyHooks;
/** @deprecated Anthropic provider-owned replay hook shortcut; use local provider hooks instead. */
declare const NATIVE_ANTHROPIC_REPLAY_HOOKS: ProviderReplayFamilyHooks;
/** @deprecated Google provider-owned replay hook shortcut; use local provider hooks instead. */
declare const PASSTHROUGH_GEMINI_REPLAY_HOOKS: ProviderReplayFamilyHooks;
//#endregion
export { buildAnthropicReplayPolicyForModel as A, isGpt5ModelId as C, resolveGpt5SystemPromptContribution as D, resolveGpt5PromptOverlayMode as E, buildPassthroughGeminiSanitizingReplayPolicy as F, buildStrictAnthropicReplayPolicy as I, resolveTaggedReasoningOutputMode as L, buildHybridAnthropicOrOpenAIReplayPolicy as M, buildNativeAnthropicReplayPolicyForModel as N, normalizeAntigravityPreviewModelId as O, buildOpenAICompatibleReplayPolicy as P, sanitizeGoogleGeminiReplayHistory as R, Gpt5PromptOverlayMode as S, renderGpt5PromptOverlay as T, resolveUnsupportedToolSchemaKeywords as _, ProviderReplayFamily as a, GPT5_FRIENDLY_PROMPT_OVERLAY as b, isProxyReasoningUnsupportedModelHint as c, matchesExactOrPrefix as d, applyModelCompatPatch as f, resolveToolCallArgumentsEncoding as g, normalizeModelCompat as h, PASSTHROUGH_GEMINI_REPLAY_HOOKS as i, buildGoogleGeminiReplayPolicy as j, normalizeGooglePreviewModelId as k, resolveClaudeThinkingProfile as l, hasToolSchemaProfile as m, NATIVE_ANTHROPIC_REPLAY_HOOKS as n, buildProviderReplayFamilyHooks as o, hasNativeWebSearchTool as p, OPENAI_COMPATIBLE_REPLAY_HOOKS as r, isClaudeAdaptiveThinkingDefaultModelId as s, ANTHROPIC_BY_MODEL_REPLAY_HOOKS as t, cloneFirstTemplateModel as u, GPT5_BEHAVIOR_CONTRACT as v, normalizeGpt5PromptOverlayMode as w, GPT5_HEARTBEAT_PROMPT_OVERLAY as x, GPT5_FRIENDLY_CHAT_PROMPT_OVERLAY as y };