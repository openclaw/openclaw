import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
//#region extensions/xai/model-definitions.ts
const XAI_BASE_URL = "https://api.x.ai/v1";
const XAI_DEFAULT_IMAGE_MODEL = "grok-imagine-image";
const XAI_IMAGE_MODELS = ["grok-imagine-image", "grok-imagine-image-quality"];
const XAI_DEFAULT_CONTEXT_WINDOW = 1e6;
const XAI_LARGE_CONTEXT_WINDOW = 2e6;
const XAI_GROK_4_CONTEXT_WINDOW = 256e3;
const XAI_CODE_CONTEXT_WINDOW = 256e3;
const XAI_DEFAULT_MAX_TOKENS = 64e3;
const XAI_LEGACY_CONTEXT_WINDOW = 131072;
const XAI_LEGACY_MAX_TOKENS = 8192;
const XAI_DEFAULT_MODEL_ID = "grok-4.3";
const XAI_DEFAULT_MODEL_REF = `xai/${XAI_DEFAULT_MODEL_ID}`;
const XAI_GROK_4_COST = {
	input: 3,
	output: 15,
	cacheRead: .75,
	cacheWrite: 0
};
const XAI_FAST_COST = {
	input: .2,
	output: .5,
	cacheRead: .05,
	cacheWrite: 0
};
const XAI_GROK_420_COST = {
	input: 1.25,
	output: 2.5,
	cacheRead: .2,
	cacheWrite: 0
};
const XAI_GROK_43_COST = {
	input: 1.25,
	output: 2.5,
	cacheRead: .2,
	cacheWrite: 0
};
const XAI_GROK_BUILD_COST = {
	input: 1,
	output: 2,
	cacheRead: .2,
	cacheWrite: 0
};
const XAI_CODE_FAST_COST = {
	input: .2,
	output: 1.5,
	cacheRead: .02,
	cacheWrite: 0
};
const XAI_MODEL_CATALOG = [
	{
		id: "grok-build-0.1",
		name: "Grok Build 0.1",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: XAI_CODE_CONTEXT_WINDOW,
		cost: XAI_GROK_BUILD_COST
	},
	{
		id: "grok-3",
		name: "Grok 3",
		reasoning: false,
		input: ["text"],
		contextWindow: XAI_LEGACY_CONTEXT_WINDOW,
		maxTokens: XAI_LEGACY_MAX_TOKENS,
		cost: XAI_GROK_4_COST
	},
	{
		id: "grok-3-fast",
		name: "Grok 3 Fast",
		reasoning: false,
		input: ["text"],
		contextWindow: XAI_LEGACY_CONTEXT_WINDOW,
		maxTokens: XAI_LEGACY_MAX_TOKENS,
		cost: {
			input: 5,
			output: 25,
			cacheRead: 1.25,
			cacheWrite: 0
		}
	},
	{
		id: "grok-3-mini",
		name: "Grok 3 Mini",
		reasoning: true,
		input: ["text"],
		contextWindow: XAI_LEGACY_CONTEXT_WINDOW,
		maxTokens: XAI_LEGACY_MAX_TOKENS,
		cost: {
			input: .3,
			output: .5,
			cacheRead: .075,
			cacheWrite: 0
		}
	},
	{
		id: "grok-3-mini-fast",
		name: "Grok 3 Mini Fast",
		reasoning: true,
		input: ["text"],
		contextWindow: XAI_LEGACY_CONTEXT_WINDOW,
		maxTokens: XAI_LEGACY_MAX_TOKENS,
		cost: {
			input: .6,
			output: 4,
			cacheRead: .15,
			cacheWrite: 0
		}
	},
	{
		id: "grok-4.3",
		name: "Grok 4.3",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
		maxTokens: XAI_DEFAULT_MAX_TOKENS,
		cost: XAI_GROK_43_COST
	},
	{
		id: "grok-4",
		name: "Grok 4",
		reasoning: true,
		input: ["text"],
		contextWindow: XAI_GROK_4_CONTEXT_WINDOW,
		maxTokens: XAI_DEFAULT_MAX_TOKENS,
		cost: XAI_GROK_4_COST
	},
	{
		id: "grok-4-0709",
		name: "Grok 4 0709",
		reasoning: false,
		input: ["text"],
		contextWindow: XAI_GROK_4_CONTEXT_WINDOW,
		maxTokens: XAI_DEFAULT_MAX_TOKENS,
		cost: XAI_GROK_4_COST
	},
	{
		id: "grok-4-fast",
		name: "Grok 4 Fast",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: XAI_LARGE_CONTEXT_WINDOW,
		maxTokens: 3e4,
		cost: XAI_FAST_COST
	},
	{
		id: "grok-4-fast-non-reasoning",
		name: "Grok 4 Fast (Non-Reasoning)",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: XAI_LARGE_CONTEXT_WINDOW,
		maxTokens: 3e4,
		cost: XAI_FAST_COST
	},
	{
		id: "grok-4-1-fast",
		name: "Grok 4.1 Fast",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: XAI_LARGE_CONTEXT_WINDOW,
		maxTokens: 3e4,
		cost: XAI_FAST_COST
	},
	{
		id: "grok-4-1-fast-non-reasoning",
		name: "Grok 4.1 Fast (Non-Reasoning)",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: XAI_LARGE_CONTEXT_WINDOW,
		maxTokens: 3e4,
		cost: XAI_FAST_COST
	},
	{
		id: "grok-4.20-beta-latest-reasoning",
		name: "Grok 4.20 Beta Latest (Reasoning)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: XAI_LARGE_CONTEXT_WINDOW,
		maxTokens: 3e4,
		cost: XAI_GROK_420_COST
	},
	{
		id: "grok-4.20-beta-latest-non-reasoning",
		name: "Grok 4.20 Beta Latest (Non-Reasoning)",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: XAI_LARGE_CONTEXT_WINDOW,
		maxTokens: 3e4,
		cost: XAI_GROK_420_COST
	}
];
const XAI_SELECTABLE_MODEL_IDS = new Set([
	"grok-build-0.1",
	"grok-4.3",
	"grok-4.20-beta-latest-reasoning",
	"grok-4.20-beta-latest-non-reasoning"
]);
const XAI_GROK_BUILD_ALIASES = new Set([
	"grok-code-fast-1",
	"grok-code-fast",
	"grok-code-fast-1-0825"
]);
const XAI_RETIRED_BUILTIN_MODEL_IDS = new Set(XAI_MODEL_CATALOG.map((entry) => entry.id).filter((id) => !XAI_SELECTABLE_MODEL_IDS.has(id)));
function normalizeXaiCatalogModelId(modelId) {
	const lower = normalizeOptionalLowercaseString(modelId) ?? "";
	const unprefixed = lower.startsWith("xai/") ? lower.slice(4) : lower;
	if (XAI_GROK_BUILD_ALIASES.has(unprefixed)) return "grok-build-0.1";
	return unprefixed;
}
function isRetiredXaiBuiltinModelId(modelId) {
	const lower = normalizeOptionalLowercaseString(modelId) ?? "";
	const unprefixed = lower.startsWith("xai/") ? lower.slice(4) : lower;
	if (XAI_GROK_BUILD_ALIASES.has(unprefixed)) return true;
	return XAI_RETIRED_BUILTIN_MODEL_IDS.has(normalizeXaiCatalogModelId(modelId));
}
function toModelDefinition(entry) {
	return {
		id: entry.id,
		name: entry.name,
		reasoning: entry.reasoning,
		input: entry.input ?? ["text"],
		cost: entry.cost,
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens ?? 64e3
	};
}
function buildXaiModelDefinition() {
	return toModelDefinition(XAI_MODEL_CATALOG.find((entry) => entry.id === "grok-4.3") ?? {
		id: "grok-4.3",
		name: "Grok 4.3",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1e6,
		maxTokens: 64e3,
		cost: XAI_GROK_43_COST
	});
}
function buildXaiCatalogModels() {
	return XAI_MODEL_CATALOG.filter((entry) => XAI_SELECTABLE_MODEL_IDS.has(entry.id)).map((entry) => toModelDefinition(entry));
}
function resolveXaiCatalogEntry(modelId) {
	const trimmed = modelId.trim();
	const lower = normalizeXaiCatalogModelId(modelId);
	const exact = XAI_MODEL_CATALOG.find((entry) => normalizeOptionalLowercaseString(entry.id) === lower);
	if (exact) return toModelDefinition(exact);
	if (lower.includes("multi-agent")) return;
	if (lower.startsWith("grok-code-fast")) return toModelDefinition({
		id: trimmed,
		name: trimmed,
		reasoning: true,
		input: ["text"],
		contextWindow: XAI_CODE_CONTEXT_WINDOW,
		maxTokens: 1e4,
		cost: XAI_CODE_FAST_COST
	});
	if (lower.startsWith("grok-3-mini-fast") || lower.startsWith("grok-3-mini") || lower.startsWith("grok-3-fast") || lower.startsWith("grok-3")) {
		const legacyCost = lower.startsWith("grok-3-mini-fast") ? {
			input: .6,
			output: 4,
			cacheRead: .15,
			cacheWrite: 0
		} : lower.startsWith("grok-3-mini") ? {
			input: .3,
			output: .5,
			cacheRead: .075,
			cacheWrite: 0
		} : lower.startsWith("grok-3-fast") ? {
			input: 5,
			output: 25,
			cacheRead: 1.25,
			cacheWrite: 0
		} : XAI_GROK_4_COST;
		return toModelDefinition({
			id: trimmed,
			name: trimmed,
			reasoning: lower.includes("mini"),
			input: ["text"],
			contextWindow: XAI_LEGACY_CONTEXT_WINDOW,
			maxTokens: XAI_LEGACY_MAX_TOKENS,
			cost: legacyCost
		});
	}
	if (lower.startsWith("grok-4.3") || lower.startsWith("grok-4.20") || lower.startsWith("grok-4-1") || lower.startsWith("grok-4-fast")) return toModelDefinition({
		id: trimmed,
		name: trimmed,
		reasoning: !lower.includes("non-reasoning"),
		input: ["text", "image"],
		contextWindow: lower.startsWith("grok-4.3") ? XAI_DEFAULT_CONTEXT_WINDOW : XAI_LARGE_CONTEXT_WINDOW,
		maxTokens: lower.startsWith("grok-4.3") ? XAI_DEFAULT_MAX_TOKENS : 3e4,
		cost: lower.startsWith("grok-4.3") ? XAI_GROK_43_COST : lower.startsWith("grok-4.20") ? XAI_GROK_420_COST : XAI_FAST_COST
	});
	if (lower.startsWith("grok-4")) return toModelDefinition({
		id: modelId.trim(),
		name: modelId.trim(),
		reasoning: lower.includes("reasoning"),
		input: ["text"],
		contextWindow: XAI_GROK_4_CONTEXT_WINDOW,
		maxTokens: XAI_DEFAULT_MAX_TOKENS,
		cost: XAI_GROK_4_COST
	});
}
//#endregion
export { XAI_DEFAULT_MODEL_ID as a, buildXaiCatalogModels as c, resolveXaiCatalogEntry as d, XAI_DEFAULT_MAX_TOKENS as i, buildXaiModelDefinition as l, XAI_DEFAULT_CONTEXT_WINDOW as n, XAI_DEFAULT_MODEL_REF as o, XAI_DEFAULT_IMAGE_MODEL as r, XAI_IMAGE_MODELS as s, XAI_BASE_URL as t, isRetiredXaiBuiltinModelId as u };
