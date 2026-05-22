import { s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { a as normalizeModelCompat } from "./provider-model-compat-77Mi9w2y.js";
import "./provider-model-shared-yPXLOOoM.js";
import "./text-runtime-CFBwIeh_.js";
//#region extensions/github-copilot/models.ts
const PROVIDER_ID = "github-copilot";
const CODEX_FORWARD_COMPAT_TARGET_IDS = new Set(["gpt-5.4", "gpt-5.3-codex"]);
const CODEX_TEMPLATE_MODEL_IDS = ["gpt-5.3-codex", "gpt-5.2-codex"];
const DEFAULT_CONTEXT_WINDOW = 128e3;
const DEFAULT_MAX_TOKENS = 8192;
function isCopilotCodexModelId(modelId) {
	return /(?:^|[-_.])codex(?:$|[-_.])/.test(modelId);
}
function resolveCopilotTransportApi(modelId) {
	return (normalizeOptionalLowercaseString(modelId) ?? "").includes("claude") ? "anthropic-messages" : "openai-responses";
}
function resolveCopilotForwardCompatModel(ctx) {
	const trimmedModelId = ctx.modelId.trim();
	if (!trimmedModelId) return;
	const lowerModelId = normalizeOptionalLowercaseString(trimmedModelId) ?? "";
	if (ctx.modelRegistry.find("github-copilot", lowerModelId)) return;
	if (CODEX_FORWARD_COMPAT_TARGET_IDS.has(lowerModelId)) for (const templateId of CODEX_TEMPLATE_MODEL_IDS) {
		const template = ctx.modelRegistry.find(PROVIDER_ID, templateId);
		if (!template) continue;
		return normalizeModelCompat({
			...template,
			id: trimmedModelId,
			name: trimmedModelId
		});
	}
	const reasoning = /^o[13](\b|$)/.test(lowerModelId) || isCopilotCodexModelId(lowerModelId);
	return normalizeModelCompat({
		id: trimmedModelId,
		name: trimmedModelId,
		provider: PROVIDER_ID,
		api: resolveCopilotTransportApi(trimmedModelId),
		reasoning,
		input: ["text", "image"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS
	});
}
//#endregion
export { resolveCopilotForwardCompatModel as n, resolveCopilotTransportApi as r, PROVIDER_ID as t };
