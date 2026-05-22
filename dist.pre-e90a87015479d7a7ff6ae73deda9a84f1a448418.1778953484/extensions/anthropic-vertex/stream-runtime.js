import { n as applyAnthropicPayloadPolicyToParams, r as resolveAnthropicPayloadPolicy } from "../../anthropic-payload-policy-B06HPpcm.js";
import "../../provider-stream-shared-imWhAw3T.js";
import { a as resolveAnthropicVertexProjectId, r as resolveAnthropicVertexClientRegion } from "../../region-BognZZO8.js";
import { streamAnthropic } from "@earendil-works/pi-ai";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
//#region extensions/anthropic-vertex/stream-runtime.ts
const defaultAnthropicVertexStreamDeps = {
	AnthropicVertex,
	streamAnthropic
};
function isClaudeOpus47Model(modelId) {
	return modelId.includes("opus-4-7") || modelId.includes("opus-4.7");
}
function isClaudeOpus46Model(modelId) {
	return modelId.includes("opus-4-6") || modelId.includes("opus-4.6");
}
function supportsAdaptiveThinking(modelId) {
	return isClaudeOpus47Model(modelId) || isClaudeOpus46Model(modelId) || modelId.includes("sonnet-4-6") || modelId.includes("sonnet-4.6");
}
function mapAnthropicAdaptiveEffort(reasoning, modelId) {
	return {
		minimal: "low",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: isClaudeOpus47Model(modelId) ? "xhigh" : isClaudeOpus46Model(modelId) ? "max" : "high"
	}[reasoning] ?? "high";
}
function resolveAnthropicVertexMaxTokens(params) {
	const modelMax = typeof params.modelMaxTokens === "number" && Number.isFinite(params.modelMaxTokens) && params.modelMaxTokens > 0 ? Math.floor(params.modelMaxTokens) : void 0;
	const requested = typeof params.requestedMaxTokens === "number" && Number.isFinite(params.requestedMaxTokens) && params.requestedMaxTokens > 0 ? Math.floor(params.requestedMaxTokens) : void 0;
	if (modelMax !== void 0 && requested !== void 0) return Math.min(requested, modelMax);
	return requested ?? modelMax;
}
function createAnthropicVertexOnPayload(params) {
	const policy = resolveAnthropicPayloadPolicy({
		provider: params.model.provider,
		api: params.model.api,
		baseUrl: params.model.baseUrl,
		cacheRetention: params.cacheRetention,
		enableCacheControl: true
	});
	function applyPolicy(payload) {
		if (payload && typeof payload === "object" && !Array.isArray(payload)) applyAnthropicPayloadPolicyToParams(payload, policy);
		return payload;
	}
	return async (payload, model) => {
		const shapedPayload = applyPolicy(payload);
		const nextPayload = await params.onPayload?.(shapedPayload, model);
		if (nextPayload === void 0 || nextPayload === shapedPayload) return shapedPayload;
		return applyPolicy(nextPayload);
	};
}
/**
* Create a StreamFn that routes through pi-ai's `streamAnthropic` with an
* injected `AnthropicVertex` client.  All streaming, message conversion, and
* event handling is handled by pi-ai — we only supply the GCP-authenticated
* client and map SimpleStreamOptions → AnthropicOptions.
*/
function createAnthropicVertexStreamFn(projectId, region, baseURL, deps = defaultAnthropicVertexStreamDeps) {
	const client = new deps.AnthropicVertex({
		region,
		...baseURL ? { baseURL } : {},
		...projectId ? { projectId } : {}
	});
	return (model, context, options) => {
		const transportModel = model;
		const maxTokens = resolveAnthropicVertexMaxTokens({
			modelMaxTokens: transportModel.maxTokens,
			requestedMaxTokens: options?.maxTokens
		});
		const opts = {
			client,
			temperature: options?.temperature,
			...maxTokens !== void 0 ? { maxTokens } : {},
			signal: options?.signal,
			cacheRetention: options?.cacheRetention,
			sessionId: options?.sessionId,
			headers: options?.headers,
			onPayload: createAnthropicVertexOnPayload({
				model: transportModel,
				cacheRetention: options?.cacheRetention,
				onPayload: options?.onPayload
			}),
			maxRetryDelayMs: options?.maxRetryDelayMs,
			metadata: options?.metadata
		};
		if (options?.reasoning) if (supportsAdaptiveThinking(model.id)) {
			opts.thinkingEnabled = true;
			opts.effort = mapAnthropicAdaptiveEffort(options.reasoning, model.id);
		} else {
			opts.thinkingEnabled = true;
			const budgets = options.thinkingBudgets;
			opts.thinkingBudgetTokens = (budgets && options.reasoning in budgets ? budgets[options.reasoning] : void 0) ?? 1e4;
		}
		else opts.thinkingEnabled = false;
		return deps.streamAnthropic(transportModel, context, opts);
	};
}
function resolveAnthropicVertexSdkBaseUrl(baseUrl) {
	const trimmed = baseUrl?.trim();
	if (!trimmed) return;
	try {
		const url = new URL(trimmed);
		const normalizedPath = url.pathname.replace(/\/+$/, "");
		if (!normalizedPath || normalizedPath === "") {
			url.pathname = "/v1";
			return url.toString().replace(/\/$/, "");
		}
		if (!normalizedPath.endsWith("/v1")) {
			url.pathname = `${normalizedPath}/v1`;
			return url.toString().replace(/\/$/, "");
		}
		return trimmed;
	} catch {
		return trimmed;
	}
}
function createAnthropicVertexStreamFnForModel(model, env = process.env, deps) {
	return createAnthropicVertexStreamFn(resolveAnthropicVertexProjectId(env), resolveAnthropicVertexClientRegion({
		baseUrl: model.baseUrl,
		env
	}), resolveAnthropicVertexSdkBaseUrl(model.baseUrl), deps);
}
//#endregion
export { createAnthropicVertexStreamFn, createAnthropicVertexStreamFnForModel };
