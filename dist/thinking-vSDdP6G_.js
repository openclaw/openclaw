import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { c as resolveClaudeThinkingProfile, u as matchesExactOrPrefix } from "./provider-model-shared-DtsPmvDx.js";
//#region extensions/vercel-ai-gateway/thinking.ts
const UPSTREAM_OPENAI_PREFIX = "openai/";
const UPSTREAM_ANTHROPIC_PREFIX = "anthropic/";
const BASE_OPENAI_THINKING_LEVELS = [
	{ id: "off" },
	{ id: "minimal" },
	{ id: "low" },
	{ id: "medium" },
	{ id: "high" }
];
const VERCEL_OPENAI_XHIGH_MODEL_IDS = [
	"gpt-5.5",
	"gpt-5.5-pro",
	"gpt-5.4",
	"gpt-5.4-pro",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.3-codex",
	"gpt-5.2",
	"gpt-5.2-codex",
	"gpt-5.1-codex"
];
function stripTrustedUpstreamPrefix(modelId, prefix) {
	const normalized = normalizeLowercaseStringOrEmpty(modelId);
	if (!normalized.startsWith(prefix)) return null;
	return normalized.slice(prefix.length).trim() || null;
}
function resolveOpenAiThinkingProfile(modelId) {
	if (!matchesExactOrPrefix(modelId, VERCEL_OPENAI_XHIGH_MODEL_IDS)) return;
	return { levels: [...BASE_OPENAI_THINKING_LEVELS, { id: "xhigh" }] };
}
function hasVercelSpecificClaudeProfile(profile) {
	return Boolean(profile.defaultLevel || profile.levels.some((level) => level.id === "adaptive" || level.id === "xhigh" || level.id === "max"));
}
function resolveVercelAiGatewayThinkingProfile(modelId) {
	const openAiModelId = stripTrustedUpstreamPrefix(modelId, UPSTREAM_OPENAI_PREFIX);
	if (openAiModelId) return resolveOpenAiThinkingProfile(openAiModelId);
	const anthropicModelId = stripTrustedUpstreamPrefix(modelId, UPSTREAM_ANTHROPIC_PREFIX);
	if (anthropicModelId) {
		const profile = resolveClaudeThinkingProfile(anthropicModelId);
		return hasVercelSpecificClaudeProfile(profile) ? profile : void 0;
	}
}
//#endregion
export { resolveVercelAiGatewayThinkingProfile as t };
