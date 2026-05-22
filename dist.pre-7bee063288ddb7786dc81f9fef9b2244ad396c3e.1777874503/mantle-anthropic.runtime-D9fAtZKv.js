import Anthropic from "@anthropic-ai/sdk";
import { streamAnthropic } from "@mariozechner/pi-ai/anthropic";
//#region extensions/amazon-bedrock-mantle/mantle-anthropic.runtime.ts
const MANTLE_ANTHROPIC_BETA = "fine-grained-tool-streaming-2025-05-14";
function resolveMantleAnthropicBaseUrl(baseUrl) {
	const trimmed = baseUrl.replace(/\/+$/, "");
	if (trimmed.endsWith("/anthropic")) return trimmed;
	if (trimmed.endsWith("/v1")) return `${trimmed.slice(0, -3)}/anthropic`;
	return `${trimmed}/anthropic`;
}
function requiresDefaultSampling(modelId) {
	return modelId.includes("claude-opus-4-7");
}
function mergeHeaders(...headerSources) {
	const merged = {};
	for (const headers of headerSources) if (headers) Object.assign(merged, headers);
	return merged;
}
function buildMantleAnthropicBaseOptions(model, options, apiKey) {
	return {
		temperature: requiresDefaultSampling(model.id) ? void 0 : options?.temperature,
		maxTokens: options?.maxTokens || Math.min(model.maxTokens, 32e3),
		signal: options?.signal,
		apiKey,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		onPayload: options?.onPayload,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata
	};
}
function adjustMaxTokensForThinking(baseMaxTokens, modelMaxTokens, reasoningLevel, customBudgets) {
	const budgets = {
		minimal: 1024,
		low: 2048,
		medium: 8192,
		high: 16384,
		xhigh: 16384,
		...customBudgets
	};
	const minOutputTokens = 1024;
	let thinkingBudget = budgets[reasoningLevel];
	const maxTokens = Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);
	if (maxTokens <= thinkingBudget) thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
	return {
		maxTokens,
		thinkingBudget
	};
}
function createMantleAnthropicStreamFn(deps) {
	return (model, context, options) => {
		const apiKey = options?.apiKey ?? "";
		const createClient = deps?.createClient ?? ((clientOptions) => new Anthropic(clientOptions));
		const stream = deps?.stream ?? streamAnthropic;
		const client = createClient({
			apiKey: null,
			authToken: apiKey,
			baseURL: resolveMantleAnthropicBaseUrl(model.baseUrl),
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders({
				accept: "application/json",
				"anthropic-dangerous-direct-browser-access": "true",
				"anthropic-beta": MANTLE_ANTHROPIC_BETA
			}, model.headers, options?.headers)
		});
		const base = buildMantleAnthropicBaseOptions(model, options, apiKey);
		const streamClient = client;
		if (!options?.reasoning || requiresDefaultSampling(model.id)) return stream(model, context, {
			...base,
			client: streamClient,
			thinkingEnabled: false
		});
		const adjusted = adjustMaxTokensForThinking(base.maxTokens || 0, model.maxTokens, options.reasoning, options.thinkingBudgets);
		return stream(model, context, {
			...base,
			client: streamClient,
			maxTokens: adjusted.maxTokens,
			thinkingEnabled: true,
			thinkingBudgetTokens: adjusted.thinkingBudget
		});
	};
}
//#endregion
export { resolveMantleAnthropicBaseUrl as n, createMantleAnthropicStreamFn as t };
