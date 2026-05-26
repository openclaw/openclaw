import { r as resolveProviderRequestCapabilities } from "./provider-attribution-B2QMzk1g.js";
import { i as stripSystemPromptCacheBoundary, r as splitSystemPromptCacheBoundary } from "./system-prompt-cache-boundary-T51pGsv9.js";
//#region src/agents/anthropic-payload-policy.ts
function resolveBaseUrlHostname(baseUrl) {
	try {
		return new URL(baseUrl).hostname;
	} catch {
		return;
	}
}
function isLongTtlEligibleEndpoint(baseUrl) {
	if (typeof baseUrl !== "string") return false;
	const hostname = resolveBaseUrlHostname(baseUrl);
	if (!hostname) return false;
	return hostname === "api.anthropic.com" || hostname === "aiplatform.googleapis.com" || hostname.endsWith("-aiplatform.googleapis.com");
}
function resolveAnthropicEphemeralCacheControl(baseUrl, cacheRetention) {
	const retention = cacheRetention ?? (process.env.PI_CACHE_RETENTION === "long" ? "long" : "short");
	if (retention === "none") return;
	const ttl = retention === "long" && (cacheRetention === "long" || isLongTtlEligibleEndpoint(baseUrl)) ? "1h" : void 0;
	return {
		type: "ephemeral",
		...ttl ? { ttl } : {}
	};
}
function applyAnthropicCacheControlToSystem(system, cacheControl) {
	if (!Array.isArray(system)) return;
	const normalizedBlocks = [];
	for (const block of system) {
		if (!block || typeof block !== "object") {
			normalizedBlocks.push(block);
			continue;
		}
		const record = block;
		if (record.type !== "text" || typeof record.text !== "string") {
			normalizedBlocks.push(block);
			continue;
		}
		const split = splitSystemPromptCacheBoundary(record.text);
		if (!split) {
			if (record.cache_control === void 0) record.cache_control = cacheControl;
			normalizedBlocks.push(record);
			continue;
		}
		const { cache_control: existingCacheControl, ...rest } = record;
		if (split.stablePrefix) normalizedBlocks.push({
			...rest,
			text: split.stablePrefix,
			cache_control: existingCacheControl ?? cacheControl
		});
		if (split.dynamicSuffix) normalizedBlocks.push({
			...rest,
			text: split.dynamicSuffix
		});
	}
	system.splice(0, system.length, ...normalizedBlocks);
}
function stripAnthropicSystemPromptBoundary(system) {
	if (!Array.isArray(system)) return;
	for (const block of system) {
		if (!block || typeof block !== "object") continue;
		const record = block;
		if (record.type === "text" && typeof record.text === "string") record.text = stripSystemPromptCacheBoundary(record.text);
	}
}
function applyAnthropicCacheControlToMessages(messages, cacheControl) {
	if (!Array.isArray(messages) || messages.length === 0) return;
	const lastMessage = messages[messages.length - 1];
	if (!lastMessage || typeof lastMessage !== "object") return;
	const record = lastMessage;
	if (record.role !== "user") return;
	const content = record.content;
	if (Array.isArray(content)) {
		const lastBlock = content[content.length - 1];
		if (!lastBlock || typeof lastBlock !== "object") return;
		const lastBlockRecord = lastBlock;
		if (lastBlockRecord.type === "text" || lastBlockRecord.type === "image" || lastBlockRecord.type === "tool_result") lastBlockRecord.cache_control = cacheControl;
		return;
	}
	if (typeof content === "string") record.content = [{
		type: "text",
		text: content,
		cache_control: cacheControl
	}];
}
/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
function resolveAnthropicPayloadPolicy(input) {
	return {
		allowsServiceTier: resolveProviderRequestCapabilities({
			provider: input.provider,
			api: input.api,
			baseUrl: input.baseUrl,
			capability: "llm",
			transport: "stream"
		}).allowsAnthropicServiceTier,
		cacheControl: input.enableCacheControl === true ? resolveAnthropicEphemeralCacheControl(input.baseUrl, input.cacheRetention) : void 0,
		serviceTier: input.serviceTier
	};
}
/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
function applyAnthropicPayloadPolicyToParams(payloadObj, policy) {
	if (policy.allowsServiceTier && policy.serviceTier !== void 0 && payloadObj.service_tier === void 0) payloadObj.service_tier = policy.serviceTier;
	if (policy.cacheControl) applyAnthropicCacheControlToSystem(payloadObj.system, policy.cacheControl);
	else stripAnthropicSystemPromptBoundary(payloadObj.system);
	if (!policy.cacheControl) return;
	applyAnthropicCacheControlToMessages(payloadObj.messages, policy.cacheControl);
}
/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
function applyAnthropicEphemeralCacheControlMarkers(payloadObj) {
	const messages = payloadObj.messages;
	if (!Array.isArray(messages)) return;
	for (const message of messages) {
		if (message.role === "system" || message.role === "developer") {
			if (typeof message.content === "string") {
				message.content = [{
					type: "text",
					text: message.content,
					cache_control: { type: "ephemeral" }
				}];
				continue;
			}
			if (Array.isArray(message.content) && message.content.length > 0) {
				const last = message.content[message.content.length - 1];
				if (last && typeof last === "object") {
					const record = last;
					if (record.type !== "thinking" && record.type !== "redacted_thinking") record.cache_control = { type: "ephemeral" };
				}
			}
			continue;
		}
		if (message.role === "assistant" && Array.isArray(message.content)) for (const block of message.content) {
			if (!block || typeof block !== "object") continue;
			const record = block;
			if (record.type === "thinking" || record.type === "redacted_thinking") delete record.cache_control;
		}
	}
}
//#endregion
export { applyAnthropicPayloadPolicyToParams as n, resolveAnthropicPayloadPolicy as r, applyAnthropicEphemeralCacheControlMarkers as t };
