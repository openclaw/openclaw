//#region src/auto-reply/thinking.ts
function normalizeProviderId(provider) {
	if (!provider) return "";
	const normalized = provider.trim().toLowerCase();
	if (normalized === "z.ai" || normalized === "z-ai") return "zai";
	return normalized;
}
function isBinaryThinkingProvider(provider) {
	return normalizeProviderId(provider) === "zai";
}
const XHIGH_MODEL_REFS = [
	"openai/gpt-5.2",
	"openai-codex/gpt-5.3-codex",
	"openai-codex/gpt-5.3-codex-spark",
	"openai-codex/gpt-5.2-codex",
	"openai-codex/gpt-5.1-codex",
	"github-copilot/gpt-5.2-codex",
	"github-copilot/gpt-5.2"
];
const XHIGH_MODEL_SET = new Set(XHIGH_MODEL_REFS.map((entry) => entry.toLowerCase()));
const XHIGH_MODEL_IDS = new Set(XHIGH_MODEL_REFS.map((entry) => entry.split("/")[1]?.toLowerCase()).filter((entry) => Boolean(entry)));
function normalizeThinkLevel(raw) {
	if (!raw) return;
	const key = raw.trim().toLowerCase();
	const collapsed = key.replace(/[\s_-]+/g, "");
	if (collapsed === "xhigh" || collapsed === "extrahigh") return "xhigh";
	if (["off"].includes(key)) return "off";
	if ([
		"on",
		"enable",
		"enabled"
	].includes(key)) return "low";
	if (["min", "minimal"].includes(key)) return "minimal";
	if ([
		"low",
		"thinkhard",
		"think-hard",
		"think_hard"
	].includes(key)) return "low";
	if ([
		"mid",
		"med",
		"medium",
		"thinkharder",
		"think-harder",
		"harder"
	].includes(key)) return "medium";
	if ([
		"high",
		"ultra",
		"ultrathink",
		"think-hard",
		"thinkhardest",
		"highest",
		"max"
	].includes(key)) return "high";
	if (["think"].includes(key)) return "minimal";
}
function supportsXHighThinking(provider, model) {
	const modelKey = model?.trim().toLowerCase();
	if (!modelKey) return false;
	const providerKey = provider?.trim().toLowerCase();
	if (providerKey) return XHIGH_MODEL_SET.has(`${providerKey}/${modelKey}`);
	return XHIGH_MODEL_IDS.has(modelKey);
}
function listThinkingLevels(provider, model) {
	const levels = [
		"off",
		"minimal",
		"low",
		"medium",
		"high"
	];
	if (supportsXHighThinking(provider, model)) levels.push("xhigh");
	return levels;
}
function listThinkingLevelLabels(provider, model) {
	if (isBinaryThinkingProvider(provider)) return ["off", "on"];
	return listThinkingLevels(provider, model);
}
function formatThinkingLevels(provider, model, separator = ", ") {
	return listThinkingLevelLabels(provider, model).join(separator);
}
function formatXHighModelHint() {
	const refs = [...XHIGH_MODEL_REFS];
	if (refs.length === 0) return "unknown model";
	if (refs.length === 1) return refs[0];
	if (refs.length === 2) return `${refs[0]} or ${refs[1]}`;
	return `${refs.slice(0, -1).join(", ")} or ${refs[refs.length - 1]}`;
}
function normalizeOnOffFullLevel(raw) {
	if (!raw) return;
	const key = raw.toLowerCase();
	if ([
		"off",
		"false",
		"no",
		"0"
	].includes(key)) return "off";
	if ([
		"full",
		"all",
		"everything"
	].includes(key)) return "full";
	if ([
		"on",
		"minimal",
		"true",
		"yes",
		"1"
	].includes(key)) return "on";
}
function normalizeVerboseLevel(raw) {
	return normalizeOnOffFullLevel(raw);
}
function normalizeUsageDisplay(raw) {
	if (!raw) return;
	const key = raw.toLowerCase();
	if ([
		"off",
		"false",
		"no",
		"0",
		"disable",
		"disabled"
	].includes(key)) return "off";
	if ([
		"on",
		"true",
		"yes",
		"1",
		"enable",
		"enabled"
	].includes(key)) return "tokens";
	if ([
		"tokens",
		"token",
		"tok",
		"minimal",
		"min"
	].includes(key)) return "tokens";
	if (["full", "session"].includes(key)) return "full";
}
function resolveResponseUsageMode(raw) {
	return normalizeUsageDisplay(raw) ?? "off";
}
function normalizeElevatedLevel(raw) {
	if (!raw) return;
	const key = raw.toLowerCase();
	if ([
		"off",
		"false",
		"no",
		"0"
	].includes(key)) return "off";
	if ([
		"full",
		"auto",
		"auto-approve",
		"autoapprove"
	].includes(key)) return "full";
	if ([
		"ask",
		"prompt",
		"approval",
		"approve"
	].includes(key)) return "ask";
	if ([
		"on",
		"true",
		"yes",
		"1"
	].includes(key)) return "on";
}
function normalizeReasoningLevel(raw) {
	if (!raw) return;
	const key = raw.toLowerCase();
	if ([
		"off",
		"false",
		"no",
		"0",
		"hide",
		"hidden",
		"disable",
		"disabled"
	].includes(key)) return "off";
	if ([
		"on",
		"true",
		"yes",
		"1",
		"show",
		"visible",
		"enable",
		"enabled"
	].includes(key)) return "on";
	if ([
		"stream",
		"streaming",
		"draft",
		"live"
	].includes(key)) return "stream";
}

//#endregion
export { normalizeElevatedLevel as a, normalizeUsageDisplay as c, supportsXHighThinking as d, listThinkingLevels as i, normalizeVerboseLevel as l, formatXHighModelHint as n, normalizeReasoningLevel as o, listThinkingLevelLabels as r, normalizeThinkLevel as s, formatThinkingLevels as t, resolveResponseUsageMode as u };