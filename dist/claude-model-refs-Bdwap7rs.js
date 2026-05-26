import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { i as CLAUDE_CLI_MODEL_ALIASES } from "./cli-constants-8udILsOP.js";
//#region extensions/anthropic/claude-model-refs.ts
const DEFAULT_CLAUDE_MODEL_BY_FAMILY = {
	opus: "claude-opus-4-7",
	sonnet: "claude-sonnet-4-6"
};
function parseProviderModelRef(raw, defaultProvider) {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0) return {
		provider: defaultProvider,
		model: trimmed,
		explicitProvider: false
	};
	const provider = trimmed.slice(0, slashIndex).trim();
	const model = trimmed.slice(slashIndex + 1).trim();
	if (!provider || !model) return null;
	return {
		provider: normalizeLowercaseStringOrEmpty(provider),
		model,
		explicitProvider: true
	};
}
function canonicalizeKnownClaudeCliModelId(modelId) {
	const trimmed = modelId.trim();
	const normalized = normalizeLowercaseStringOrEmpty(trimmed);
	if (!normalized) return null;
	if (normalized.startsWith("claude-")) return trimmed;
	const defaultModel = DEFAULT_CLAUDE_MODEL_BY_FAMILY[normalized];
	if (defaultModel) return defaultModel;
	const family = CLAUDE_CLI_MODEL_ALIASES[normalized];
	if (!family) return null;
	const version = normalized.slice(`${family}-`.length);
	if (!version || version === normalized) return null;
	return `claude-${family}-${version.replaceAll(".", "-")}`;
}
function resolveClaudeCliAnthropicModelRefs(raw) {
	const parsed = parseProviderModelRef(raw, "anthropic");
	if (!parsed) return null;
	if (parsed.provider !== "anthropic" && parsed.provider !== "claude-cli") return null;
	const selectedRef = `anthropic/${parsed.model}`;
	const runtimeRefs = new Set([selectedRef]);
	const canonicalModelId = canonicalizeKnownClaudeCliModelId(parsed.model);
	if (!parsed.explicitProvider && !canonicalModelId) return null;
	const rewriteRef = canonicalModelId || parsed.provider === "claude-cli" ? `anthropic/${canonicalModelId ?? parsed.model}` : void 0;
	if (rewriteRef) runtimeRefs.add(rewriteRef);
	return {
		selectedRef,
		runtimeRefs: [...runtimeRefs],
		...rewriteRef ? { rewriteRef } : {}
	};
}
function resolveKnownAnthropicModelRef(raw) {
	if (!raw) return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	return resolveClaudeCliAnthropicModelRefs(trimmed)?.rewriteRef ?? trimmed;
}
//#endregion
export { resolveKnownAnthropicModelRef as n, resolveClaudeCliAnthropicModelRefs as t };
