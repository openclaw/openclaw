import { a as normalizeLowercaseStringOrEmpty, f as readStringValue } from "./string-coerce-Bje8XVt9.js";
import { t as createSubsystemLogger } from "./subsystem-DNg_cpPU.js";
import { c as shouldUseEnvHttpProxyForUrl } from "./proxy-env-CSSpFHDS.js";
import { L as resolveProviderTransportTurnStateWithPlugin } from "./provider-runtime-CphpzAjI.js";
import { r as resolveProviderRequestCapabilities } from "./provider-attribution-DzSzEwzu.js";
import { a as mergeModelProviderRequestOverrides, i as getModelProviderRequestTransport, l as resolveProviderRequestPolicyConfig, n as buildProviderRequestDispatcherPolicy } from "./provider-request-config-Bca1NoEF.js";
import { c as detectOpenAICompletionsCompat } from "./provider-model-compat-DUJvsUk1.js";
import { r as resolveDebugProxySettings } from "./env-D4mlHygJ.js";
import { i as stripSystemPromptCacheBoundary } from "./system-prompt-cache-boundary-DCbx0DRT.js";
import { t as normalizeToolParameterSchema } from "./pi-tools-parameter-schema-DQ0tASWE.js";
import { n as hasCopilotVisionInput, t as buildCopilotDynamicHeaders } from "./copilot-dynamic-headers-BIVfxY85.js";
import { v as ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist } from "./ssrf-Do8_-OpG.js";
import { a as withTrustedEnvProxyGuardedFetchMode, n as fetchWithSsrFGuard } from "./fetch-guard-Ce5w8j8c.js";
import { n as repairToolUseResultPairing } from "./session-transcript-repair-iTSo5i-e.js";
import { randomUUID } from "node:crypto";
import { calculateCost, createAssistantMessageEventStream, getEnvApiKey, parseStreamingJson } from "@mariozechner/pi-ai";
import { convertMessages } from "@mariozechner/pi-ai/openai-completions";
import OpenAI, { AzureOpenAI } from "openai";
//#region src/agents/openai-strict-tool-setting.ts
const optionalString = readStringValue;
function resolvesToNativeOpenAIStrictTools(model, transport) {
	const capabilities = resolveProviderRequestCapabilities({
		provider: optionalString(model.provider),
		api: optionalString(model.api),
		baseUrl: optionalString(model.baseUrl),
		capability: "llm",
		transport,
		modelId: optionalString(model.id),
		compat: model.compat
	});
	if (!capabilities.usesKnownNativeOpenAIRoute) return false;
	return capabilities.provider === "openai" || capabilities.provider === "openai-codex" || capabilities.provider === "azure-openai" || capabilities.provider === "azure-openai-responses";
}
function resolveOpenAIStrictToolSetting(model, options) {
	if (resolvesToNativeOpenAIStrictTools(model, options?.transport ?? "stream")) return true;
	if (options?.supportsStrictMode) return false;
}
//#endregion
//#region src/agents/openai-reasoning-effort.ts
const GPT_5_REASONING_EFFORTS = [
	"minimal",
	"low",
	"medium",
	"high"
];
const GPT_51_REASONING_EFFORTS = [
	"none",
	"low",
	"medium",
	"high"
];
const GPT_52_REASONING_EFFORTS = [
	"none",
	"low",
	"medium",
	"high",
	"xhigh"
];
const GPT_CODEX_REASONING_EFFORTS = [
	"low",
	"medium",
	"high",
	"xhigh"
];
const GPT_PRO_REASONING_EFFORTS = [
	"medium",
	"high",
	"xhigh"
];
const GPT_5_PRO_REASONING_EFFORTS = ["high"];
const GPT_51_CODEX_MAX_REASONING_EFFORTS = [
	"none",
	"medium",
	"high",
	"xhigh"
];
const GPT_51_CODEX_MINI_REASONING_EFFORTS = ["medium"];
const GENERIC_REASONING_EFFORTS = [
	"low",
	"medium",
	"high"
];
function normalizeModelId(id) {
	return normalizeLowercaseStringOrEmpty(id ?? "").replace(/-\d{4}-\d{2}-\d{2}$/u, "");
}
function isOpenAIGpt54MiniModel(model) {
	const id = normalizeModelId(typeof model.id === "string" ? model.id : void 0);
	return /^gpt-5\.4-mini(?:-|$)/u.test(id);
}
function normalizeOpenAIReasoningEffort(effort) {
	return effort === "minimal" ? "minimal" : effort;
}
function readCompatReasoningEfforts(compat) {
	if (!compat || typeof compat !== "object") return;
	const raw = compat.supportedReasoningEfforts;
	if (!Array.isArray(raw)) return;
	const supported = [...new Set(raw.filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
	return supported.length > 0 ? supported : void 0;
}
function isDisabledReasoningEffort(effort) {
	return effort === "none" || effort === "off";
}
function resolveOpenAISupportedReasoningEfforts(model) {
	const compatEfforts = readCompatReasoningEfforts(model.compat);
	if (compatEfforts) return compatEfforts;
	const provider = normalizeLowercaseStringOrEmpty(typeof model.provider === "string" ? model.provider : "");
	const id = normalizeModelId(typeof model.id === "string" ? model.id : void 0);
	if (id === "gpt-5.1-codex-mini") return GPT_51_CODEX_MINI_REASONING_EFFORTS;
	if (id === "gpt-5.1-codex-max") return GPT_51_CODEX_MAX_REASONING_EFFORTS;
	if (/^gpt-5(?:\.\d+)?-codex(?:-|$)/u.test(id) || provider === "openai-codex") return GPT_CODEX_REASONING_EFFORTS;
	if (id === "gpt-5-pro") return GPT_5_PRO_REASONING_EFFORTS;
	if (/^gpt-5\.[2-9](?:\.\d+)?-pro(?:-|$)/u.test(id)) return GPT_PRO_REASONING_EFFORTS;
	if (/^gpt-5\.[2-9](?:\.\d+)?(?:-|$)/u.test(id)) return GPT_52_REASONING_EFFORTS;
	if (/^gpt-5\.1(?:-|$)/u.test(id)) return GPT_51_REASONING_EFFORTS;
	if (/^gpt-5(?:-|$)/u.test(id)) return GPT_5_REASONING_EFFORTS;
	return GENERIC_REASONING_EFFORTS;
}
function supportsOpenAIReasoningEffort(model, effort) {
	return resolveOpenAISupportedReasoningEfforts(model).includes(normalizeOpenAIReasoningEffort(effort));
}
function resolveOpenAIReasoningEffortForModel(params) {
	const requested = normalizeOpenAIReasoningEffort(params.effort);
	const normalized = normalizeOpenAIReasoningEffort(params.fallbackMap?.[requested] ?? requested);
	const supported = resolveOpenAISupportedReasoningEfforts(params.model);
	if (supported.includes(normalized)) return normalized;
	if (isDisabledReasoningEffort(requested) || isDisabledReasoningEffort(normalized)) return;
	if (requested === "minimal" && supported.includes("low")) return "low";
	if ((requested === "minimal" || requested === "low") && supported.includes("medium")) return "medium";
	if (requested === "xhigh" && supported.includes("high")) return "high";
	return supported.find((effort) => effort !== "none");
}
//#endregion
//#region src/agents/openai-reasoning-compat.ts
const OPENAI_MEDIUM_ONLY_REASONING_MODEL_IDS = new Set(["gpt-5.1-codex-mini"]);
function readCompatReasoningEffortMap(compat) {
	if (!compat || typeof compat !== "object") return {};
	const rawMap = compat.reasoningEffortMap;
	if (!rawMap || typeof rawMap !== "object") return {};
	return Object.fromEntries(Object.entries(rawMap).filter((entry) => typeof entry[0] === "string" && typeof entry[1] === "string"));
}
function resolveOpenAIReasoningEffortMap(model, fallbackMap = {}) {
	const provider = normalizeLowercaseStringOrEmpty(model.provider ?? "");
	const id = normalizeLowercaseStringOrEmpty(model.id ?? "");
	const builtinMap = (provider === "openai" || provider === "openai-codex") && OPENAI_MEDIUM_ONLY_REASONING_MODEL_IDS.has(id) ? {
		minimal: "medium",
		low: "medium"
	} : {};
	return {
		...fallbackMap,
		...builtinMap,
		...readCompatReasoningEffortMap(model.compat)
	};
}
function mapOpenAIReasoningEffortForModel(params) {
	const { effort } = params;
	if (effort === void 0) return effort;
	return resolveOpenAIReasoningEffortForModel({
		model: params.model,
		effort,
		fallbackMap: resolveOpenAIReasoningEffortMap(params.model, params.fallbackMap)
	});
}
//#endregion
//#region src/agents/openai-tool-schema.ts
function normalizeStrictOpenAIJsonSchema(schema) {
	return normalizeStrictOpenAIJsonSchemaRecursive(normalizeToolParameterSchema(schema ?? {}), 0);
}
function normalizeStrictOpenAIJsonSchemaRecursive(schema, depth) {
	if (Array.isArray(schema)) {
		let changed = false;
		const normalized = schema.map((entry) => {
			const next = normalizeStrictOpenAIJsonSchemaRecursive(entry, depth);
			changed ||= next !== entry;
			return next;
		});
		return changed ? normalized : schema;
	}
	if (!schema || typeof schema !== "object") return schema;
	const record = schema;
	let changed = false;
	const normalized = {};
	for (const [key, value] of Object.entries(record)) {
		const next = normalizeStrictOpenAIJsonSchemaRecursive(value, key === "properties" ? depth : depth + 1);
		normalized[key] = next;
		changed ||= next !== value;
	}
	if (normalized.type === "object") {
		const properties = normalized.properties && typeof normalized.properties === "object" && !Array.isArray(normalized.properties) ? normalized.properties : void 0;
		if (properties && Object.keys(properties).length === 0 && !Array.isArray(normalized.required)) {
			normalized.required = [];
			changed = true;
		}
		if (depth === 0 && !("additionalProperties" in normalized)) {
			normalized.additionalProperties = false;
			changed = true;
		}
	}
	return changed ? normalized : schema;
}
function normalizeOpenAIStrictToolParameters(schema, strict) {
	if (!strict) return normalizeToolParameterSchema(schema ?? {});
	return normalizeStrictOpenAIJsonSchema(schema);
}
function isStrictOpenAIJsonSchemaCompatible(schema) {
	return isStrictOpenAIJsonSchemaCompatibleRecursive(normalizeStrictOpenAIJsonSchema(schema));
}
function findOpenAIStrictToolSchemaDiagnostics(tools) {
	return tools.flatMap((tool, toolIndex) => {
		const violations = findStrictOpenAIJsonSchemaViolations(normalizeStrictOpenAIJsonSchema(tool.parameters), `${typeof tool.name === "string" && tool.name ? tool.name : `tool[${toolIndex}]`}.parameters`);
		if (violations.length === 0) return [];
		return [{
			toolIndex,
			...typeof tool.name === "string" && tool.name ? { toolName: tool.name } : {},
			violations
		}];
	});
}
function isStrictOpenAIJsonSchemaCompatibleRecursive(schema) {
	if (Array.isArray(schema)) return schema.every((entry) => isStrictOpenAIJsonSchemaCompatibleRecursive(entry));
	if (!schema || typeof schema !== "object") return true;
	const record = schema;
	if ("anyOf" in record || "oneOf" in record || "allOf" in record) return false;
	if (Array.isArray(record.type)) return false;
	if (record.type === "object" && record.additionalProperties !== false) return false;
	if (record.type === "object") {
		const properties = record.properties && typeof record.properties === "object" && !Array.isArray(record.properties) ? record.properties : {};
		const required = Array.isArray(record.required) ? record.required.filter((entry) => typeof entry === "string") : void 0;
		if (!required) return false;
		const requiredSet = new Set(required);
		if (Object.keys(properties).some((key) => !requiredSet.has(key))) return false;
	}
	return Object.entries(record).every(([key, entry]) => {
		if (key === "properties" && entry && typeof entry === "object" && !Array.isArray(entry)) return Object.values(entry).every((value) => isStrictOpenAIJsonSchemaCompatibleRecursive(value));
		return isStrictOpenAIJsonSchemaCompatibleRecursive(entry);
	});
}
function findStrictOpenAIJsonSchemaViolations(schema, path) {
	if (Array.isArray(schema)) return schema.flatMap((entry, index) => findStrictOpenAIJsonSchemaViolations(entry, `${path}[${index}]`));
	if (!schema || typeof schema !== "object") return [];
	const record = schema;
	const violations = [];
	for (const key of [
		"anyOf",
		"oneOf",
		"allOf"
	]) if (key in record) violations.push(`${path}.${key}`);
	if (Array.isArray(record.type)) violations.push(`${path}.type`);
	if (record.type === "object") {
		if (record.additionalProperties !== false) violations.push(`${path}.additionalProperties`);
		const properties = record.properties && typeof record.properties === "object" && !Array.isArray(record.properties) ? record.properties : {};
		const required = Array.isArray(record.required) ? record.required.filter((entry) => typeof entry === "string") : void 0;
		if (!required) violations.push(`${path}.required`);
		else {
			const requiredSet = new Set(required);
			for (const key of Object.keys(properties)) if (!requiredSet.has(key)) violations.push(`${path}.required.${key}`);
		}
	}
	if (record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)) for (const [key, value] of Object.entries(record.properties)) violations.push(...findStrictOpenAIJsonSchemaViolations(value, `${path}.properties.${key}`));
	for (const [key, value] of Object.entries(record)) {
		if (key === "properties") continue;
		if (value && typeof value === "object") violations.push(...findStrictOpenAIJsonSchemaViolations(value, `${path}.${key}`));
	}
	return violations;
}
function resolveOpenAIStrictToolFlagForInventory(tools, strict) {
	if (strict !== true) return strict === false ? false : void 0;
	return tools.every((tool) => isStrictOpenAIJsonSchemaCompatible(tool.parameters));
}
//#endregion
//#region src/agents/provider-transport-fetch.ts
const DEFAULT_MAX_SDK_RETRY_WAIT_SECONDS = 60;
function hasReadableSseData(block) {
	const dataLines = block.split(/\r\n|\n|\r/).filter((line) => line === "data" || line.startsWith("data:")).map((line) => {
		if (line === "data") return "";
		const value = line.slice(5);
		return value.startsWith(" ") ? value.slice(1) : value;
	});
	return dataLines.length > 0 && dataLines.join("\n").trim().length > 0;
}
function findSseEventBoundary(buffer) {
	let best;
	for (const delimiter of [
		"\r\n\r\n",
		"\n\n",
		"\r\r"
	]) {
		const index = buffer.indexOf(delimiter);
		if (index === -1) continue;
		if (!best || index < best.index) best = {
			index,
			length: delimiter.length
		};
	}
	return best;
}
function sanitizeOpenAISdkSseResponse(response) {
	const contentType = response.headers.get("content-type") ?? "";
	if (!response.body || !/\btext\/event-stream\b/i.test(contentType)) return response;
	const source = response.body;
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let reader;
	let buffer = "";
	const enqueueSanitized = (controller, text) => {
		buffer += text;
		for (;;) {
			const boundary = findSseEventBoundary(buffer);
			if (!boundary) return;
			const block = buffer.slice(0, boundary.index);
			const separator = buffer.slice(boundary.index, boundary.index + boundary.length);
			buffer = buffer.slice(boundary.index + boundary.length);
			if (hasReadableSseData(block)) controller.enqueue(encoder.encode(`${block}${separator}`));
		}
	};
	const sanitizedBody = new ReadableStream({
		start() {
			reader = source.getReader();
		},
		async pull(controller) {
			try {
				const chunk = await reader?.read();
				if (!chunk || chunk.done) {
					const tail = decoder.decode();
					if (tail) enqueueSanitized(controller, tail);
					if (buffer && hasReadableSseData(buffer)) controller.enqueue(encoder.encode(buffer));
					buffer = "";
					controller.close();
					return;
				}
				enqueueSanitized(controller, decoder.decode(chunk.value, { stream: true }));
			} catch (error) {
				controller.error(error);
			}
		},
		async cancel(reason) {
			await reader?.cancel(reason);
		}
	});
	return new Response(sanitizedBody, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	});
}
function parseRetryAfterSeconds(headers) {
	const retryAfterMs = headers.get("retry-after-ms");
	if (retryAfterMs) {
		const milliseconds = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds / 1e3;
	}
	const retryAfter = headers.get("retry-after");
	if (!retryAfter) return;
	const seconds = Number.parseFloat(retryAfter);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds;
	const retryAt = Date.parse(retryAfter);
	if (Number.isNaN(retryAt)) return;
	return Math.max(0, (retryAt - Date.now()) / 1e3);
}
function resolveMaxSdkRetryWaitSeconds() {
	const raw = process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS?.trim();
	if (!raw) return DEFAULT_MAX_SDK_RETRY_WAIT_SECONDS;
	if (/^(?:0|false|off|none|disabled)$/i.test(raw)) return;
	const seconds = Number.parseFloat(raw);
	if (Number.isFinite(seconds) && seconds > 0) return seconds;
	return DEFAULT_MAX_SDK_RETRY_WAIT_SECONDS;
}
function shouldBypassLongSdkRetry(response) {
	const maxWaitSeconds = resolveMaxSdkRetryWaitSeconds();
	if (maxWaitSeconds === void 0) return false;
	const status = response.status;
	if (!(status === 408 || status === 409 || status === 429 || status >= 500)) return false;
	const retryAfterSeconds = parseRetryAfterSeconds(response.headers);
	if (retryAfterSeconds !== void 0) return retryAfterSeconds > maxWaitSeconds;
	return status === 429;
}
function buildManagedResponse(response, release, refreshTimeout) {
	if (!response.body) {
		release();
		return response;
	}
	const source = response.body;
	let reader;
	let released = false;
	const finalize = async () => {
		if (released) return;
		released = true;
		await release().catch(() => void 0);
	};
	const wrappedBody = new ReadableStream({
		start() {
			reader = source.getReader();
		},
		async pull(controller) {
			try {
				const chunk = await reader?.read();
				if (!chunk || chunk.done) {
					controller.close();
					await finalize();
					return;
				}
				refreshTimeout?.();
				controller.enqueue(chunk.value);
			} catch (error) {
				controller.error(error);
				await finalize();
			}
		},
		async cancel(reason) {
			try {
				await reader?.cancel(reason);
			} finally {
				await finalize();
			}
		}
	});
	return new Response(wrappedBody, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	});
}
function resolveModelRequestPolicy(model) {
	const debugProxy = resolveDebugProxySettings();
	let explicitDebugProxyUrl;
	if (debugProxy.enabled && debugProxy.proxyUrl) try {
		if (new URL(model.baseUrl).protocol === "https:") explicitDebugProxyUrl = debugProxy.proxyUrl;
	} catch {}
	const request = mergeModelProviderRequestOverrides(getModelProviderRequestTransport(model), { proxy: explicitDebugProxyUrl ? {
		mode: "explicit-proxy",
		url: explicitDebugProxyUrl
	} : void 0 });
	return resolveProviderRequestPolicyConfig({
		provider: model.provider,
		api: model.api,
		baseUrl: model.baseUrl,
		capability: "llm",
		transport: "stream",
		request
	});
}
function resolveModelRequestTimeoutMs(model, timeoutMs) {
	if (timeoutMs !== void 0) return timeoutMs;
	const modelTimeoutMs = model.requestTimeoutMs;
	return typeof modelTimeoutMs === "number" && Number.isFinite(modelTimeoutMs) && modelTimeoutMs > 0 ? Math.floor(modelTimeoutMs) : void 0;
}
function resolveHttpHostname(value) {
	if (typeof value !== "string" || !value.trim()) return;
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
		return parsed.hostname.toLowerCase();
	} catch {
		return;
	}
}
function resolveModelTransportSsrFPolicy(params) {
	const baseUrl = params.model.baseUrl;
	const baseHostname = resolveHttpHostname(baseUrl);
	const requestHostname = resolveHttpHostname(params.url);
	const fakeIpPolicy = typeof baseUrl === "string" && baseHostname && requestHostname === baseHostname ? ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist(baseUrl) : void 0;
	if (fakeIpPolicy) return {
		...fakeIpPolicy,
		...params.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}
	};
	return params.allowPrivateNetwork ? { allowPrivateNetwork: true } : void 0;
}
function buildGuardedModelFetch(model, timeoutMs) {
	const requestConfig = resolveModelRequestPolicy(model);
	const dispatcherPolicy = buildProviderRequestDispatcherPolicy(requestConfig);
	const requestTimeoutMs = resolveModelRequestTimeoutMs(model, timeoutMs);
	return async (input, init) => {
		const request = input instanceof Request ? new Request(input, init) : void 0;
		const url = request?.url ?? (input instanceof URL ? input.toString() : typeof input === "string" ? input : (() => {
			throw new Error("Unsupported fetch input for transport-aware model request");
		})());
		const policy = resolveModelTransportSsrFPolicy({
			model,
			url,
			allowPrivateNetwork: requestConfig.allowPrivateNetwork
		});
		const guardedFetchOptions = {
			url,
			init: (request && {
				method: request.method,
				headers: request.headers,
				body: request.body ?? void 0,
				redirect: request.redirect,
				signal: request.signal,
				...request.body ? { duplex: "half" } : {}
			}) ?? init,
			capture: { meta: {
				provider: model.provider,
				api: model.api,
				model: model.id
			} },
			dispatcherPolicy,
			timeoutMs: requestTimeoutMs,
			allowCrossOriginUnsafeRedirectReplay: false,
			...policy ? { policy } : {}
		};
		const result = await fetchWithSsrFGuard(!dispatcherPolicy && shouldUseEnvHttpProxyForUrl(url) ? withTrustedEnvProxyGuardedFetchMode(guardedFetchOptions) : guardedFetchOptions);
		let response = result.response;
		if (shouldBypassLongSdkRetry(response)) {
			const headers = new Headers(response.headers);
			headers.set("x-should-retry", "false");
			response = new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers
			});
		}
		response = buildManagedResponse(response, result.release, result.refreshTimeout);
		return sanitizeOpenAISdkSseResponse(response);
	};
}
//#endregion
//#region src/agents/transport-message-transform.ts
const SYNTHETIC_TOOL_RESULT_APIS = new Set([
	"anthropic-messages",
	"openclaw-anthropic-messages-transport",
	"bedrock-converse-stream",
	"google-generative-ai",
	"openclaw-google-generative-ai-transport",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"openclaw-openai-responses-transport",
	"openclaw-azure-openai-responses-transport"
]);
const CODEX_STYLE_ABORTED_OUTPUT_APIS = new Set([
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"openclaw-openai-responses-transport",
	"openclaw-azure-openai-responses-transport"
]);
function defaultAllowSyntheticToolResults(modelApi) {
	return SYNTHETIC_TOOL_RESULT_APIS.has(modelApi);
}
function isFailedAssistantTurn(message) {
	if (message.role !== "assistant") return false;
	return message.stopReason === "error" || message.stopReason === "aborted";
}
function transformTransportMessages(messages, model, normalizeToolCallId) {
	const allowSyntheticToolResults = defaultAllowSyntheticToolResults(model.api);
	const syntheticToolResultText = CODEX_STYLE_ABORTED_OUTPUT_APIS.has(model.api) ? "aborted" : "No result provided";
	const toolCallIdMap = /* @__PURE__ */ new Map();
	const replayable = messages.map((msg) => {
		if (msg.role === "user") return msg;
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			return normalizedId && normalizedId !== msg.toolCallId ? {
				...msg,
				toolCallId: normalizedId
			} : msg;
		}
		if (msg.role !== "assistant") return msg;
		const isSameModel = msg.provider === model.provider && msg.api === model.api && msg.model === model.id;
		const content = [];
		for (const block of msg.content) {
			if (block.type === "thinking") {
				if (block.redacted) {
					if (isSameModel) content.push(block);
					continue;
				}
				if (isSameModel && block.thinkingSignature) {
					content.push(block);
					continue;
				}
				if (!block.thinking.trim()) continue;
				content.push(isSameModel ? block : {
					type: "text",
					text: block.thinking
				});
				continue;
			}
			if (block.type === "text") {
				content.push(isSameModel ? block : {
					type: "text",
					text: block.text
				});
				continue;
			}
			if (block.type !== "toolCall") {
				content.push(block);
				continue;
			}
			let normalizedToolCall = block;
			if (!isSameModel && block.thoughtSignature) {
				normalizedToolCall = { ...normalizedToolCall };
				delete normalizedToolCall.thoughtSignature;
			}
			if (!isSameModel && normalizeToolCallId) {
				const normalizedId = normalizeToolCallId(block.id, model, msg);
				if (normalizedId !== block.id) {
					toolCallIdMap.set(block.id, normalizedId);
					normalizedToolCall = {
						...normalizedToolCall,
						id: normalizedId
					};
				}
			}
			content.push(normalizedToolCall);
		}
		return {
			...msg,
			content
		};
	}).filter((msg) => !isFailedAssistantTurn(msg));
	if (!allowSyntheticToolResults) return replayable;
	return repairToolUseResultPairing(replayable, {
		erroredAssistantResultPolicy: "drop",
		missingToolResultText: syntheticToolResultText
	}).messages;
}
//#endregion
//#region src/agents/transport-stream-shared.ts
const EMPTY_TOOL_RESULT_TEXT = "(no output)";
function sanitizeTransportPayloadText(text) {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}
function sanitizeNonEmptyTransportPayloadText(text, fallback = EMPTY_TOOL_RESULT_TEXT) {
	const sanitized = sanitizeTransportPayloadText(text);
	return sanitized.trim().length > 0 ? sanitized : fallback;
}
function coerceTransportToolCallArguments(argumentsValue) {
	if (argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)) return argumentsValue;
	if (typeof argumentsValue === "string") try {
		const parsed = JSON.parse(argumentsValue);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
	} catch {}
	return {};
}
function mergeTransportHeaders(...headerSources) {
	const merged = {};
	for (const headers of headerSources) if (headers) Object.assign(merged, headers);
	return Object.keys(merged).length > 0 ? merged : void 0;
}
function mergeTransportMetadata(payload, metadata) {
	if (!metadata || Object.keys(metadata).length === 0) return payload;
	const existingMetadata = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata) ? payload.metadata : void 0;
	return {
		...payload,
		metadata: {
			...existingMetadata,
			...metadata
		}
	};
}
function createEmptyTransportUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
}
function createWritableTransportEventStream() {
	const eventStream = createAssistantMessageEventStream();
	return {
		eventStream,
		stream: eventStream
	};
}
function finalizeTransportStream(params) {
	const { stream, output, signal } = params;
	if (signal?.aborted) throw new Error("Request was aborted");
	if (output.stopReason === "aborted" || output.stopReason === "error") throw new Error("An unknown error occurred");
	stream.push({
		type: "done",
		reason: output.stopReason,
		message: output
	});
	stream.end();
}
function failTransportStream(params) {
	const { stream, output, signal, error, cleanup } = params;
	cleanup?.();
	output.stopReason = signal?.aborted ? "aborted" : "error";
	output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
	stream.push({
		type: "error",
		reason: output.stopReason,
		error: output
	});
	stream.end();
}
//#endregion
//#region src/agents/openai-completions-string-content.ts
function flattenStringOnlyCompletionContent(content) {
	if (!Array.isArray(content)) return content;
	const textParts = [];
	for (const item of content) {
		if (!item || typeof item !== "object" || item.type !== "text" || typeof item.text !== "string") return content;
		textParts.push(item.text);
	}
	return textParts.join("\n");
}
function flattenCompletionMessagesToStringContent(messages) {
	return messages.map((message) => {
		if (!message || typeof message !== "object") return message;
		const content = message.content;
		const flattenedContent = flattenStringOnlyCompletionContent(content);
		if (flattenedContent === content) return message;
		return {
			...message,
			content: flattenedContent
		};
	});
}
//#endregion
//#region src/agents/openai-responses-payload-policy.ts
const OPENAI_RESPONSES_APIS = new Set([
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses"
]);
const OPENAI_RESPONSES_PROVIDERS = new Set([
	"openai",
	"azure-openai",
	"azure-openai-responses"
]);
const LOCAL_ENDPOINT_HOSTS = new Set([
	"localhost",
	"127.0.0.1",
	"::1",
	"[::1]"
]);
const MODELSTUDIO_NATIVE_BASE_URLS = new Set([
	"https://coding-intl.dashscope.aliyuncs.com/v1",
	"https://coding.dashscope.aliyuncs.com/v1",
	"https://dashscope.aliyuncs.com/compatible-mode/v1",
	"https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
]);
const MOONSHOT_NATIVE_BASE_URLS = new Set(["https://api.moonshot.ai/v1", "https://api.moonshot.cn/v1"]);
function normalizeLowercaseString(value) {
	const stringValue = readStringValue(value)?.trim().toLowerCase();
	return stringValue ? stringValue : void 0;
}
function normalizeComparableBaseUrl(value) {
	const trimmed = readStringValue(value)?.trim();
	if (!trimmed) return;
	const parsedValue = /^[a-z0-9.[\]-]+(?::\d+)?(?:[/?#].*)?$/i.test(trimmed) ? `https://${trimmed}` : trimmed;
	try {
		const url = new URL(parsedValue);
		if (url.protocol !== "http:" && url.protocol !== "https:") return;
		url.hash = "";
		url.search = "";
		return url.toString().replace(/\/+$/, "").toLowerCase();
	} catch {
		return;
	}
}
function resolveUrlHostname(value) {
	const trimmed = readStringValue(value)?.trim();
	if (!trimmed) return;
	try {
		return new URL(trimmed).hostname.toLowerCase();
	} catch {
		try {
			return new URL(`https://${trimmed}`).hostname.toLowerCase();
		} catch {
			return;
		}
	}
}
function hostMatchesSuffix(host, suffix) {
	return suffix.startsWith(".") || suffix.startsWith("-") ? host.endsWith(suffix) : host === suffix || host.endsWith(`.${suffix}`);
}
function isLocalEndpointHost(host) {
	return LOCAL_ENDPOINT_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal");
}
function resolveBundledOpenAIResponsesEndpointClass(baseUrl) {
	const trimmed = readStringValue(baseUrl)?.trim();
	if (!trimmed) return "default";
	const host = resolveUrlHostname(trimmed);
	if (!host) return "invalid";
	const comparableBaseUrl = normalizeComparableBaseUrl(trimmed);
	switch (host) {
		case "api.anthropic.com": return "anthropic-public";
		case "api.cerebras.ai": return "cerebras-native";
		case "llm.chutes.ai": return "chutes-native";
		case "api.deepseek.com": return "deepseek-native";
		case "api.groq.com": return "groq-native";
		case "api.mistral.ai": return "mistral-public";
		case "api.openai.com": return "openai-public";
		case "chatgpt.com": return "openai-codex";
		case "generativelanguage.googleapis.com": return "google-generative-ai";
		case "aiplatform.googleapis.com": return "google-vertex";
		case "api.x.ai":
		case "api.grok.x.ai": return "xai-native";
		case "api.z.ai": return "zai-native";
	}
	if (hostMatchesSuffix(host, ".githubcopilot.com")) return "github-copilot-native";
	if (hostMatchesSuffix(host, ".openai.azure.com")) return "azure-openai";
	if (hostMatchesSuffix(host, "openrouter.ai")) return "openrouter";
	if (hostMatchesSuffix(host, "opencode.ai")) return "opencode-native";
	if (hostMatchesSuffix(host, "-aiplatform.googleapis.com")) return "google-vertex";
	if (comparableBaseUrl && MOONSHOT_NATIVE_BASE_URLS.has(comparableBaseUrl)) return "moonshot-native";
	if (comparableBaseUrl && MODELSTUDIO_NATIVE_BASE_URLS.has(comparableBaseUrl)) return "modelstudio-native";
	if (isLocalEndpointHost(host)) return "local";
	return "custom";
}
function isOpenAIResponsesApi(api) {
	return api !== void 0 && OPENAI_RESPONSES_APIS.has(api);
}
function readCompatPayloadBoolean(compat, key) {
	if (!compat || typeof compat !== "object") return;
	const value = compat[key];
	return typeof value === "boolean" ? value : void 0;
}
function resolveOpenAIResponsesPayloadCapabilities(model) {
	const provider = normalizeLowercaseString(model.provider);
	const api = normalizeLowercaseString(model.api);
	const endpointClass = resolveBundledOpenAIResponsesEndpointClass(model.baseUrl);
	const isResponsesApi = isOpenAIResponsesApi(api);
	const usesConfiguredBaseUrl = endpointClass !== "default";
	const usesKnownNativeOpenAIEndpoint = endpointClass === "openai-public" || endpointClass === "openai-codex" || endpointClass === "azure-openai";
	const usesKnownNativeOpenAIRoute = endpointClass === "default" ? provider === "openai" : usesKnownNativeOpenAIEndpoint;
	const usesExplicitProxyLikeEndpoint = usesConfiguredBaseUrl && !usesKnownNativeOpenAIEndpoint;
	const promptCacheKeySupport = readCompatPayloadBoolean(model.compat, "supportsPromptCacheKey");
	const shouldStripResponsesPromptCache = promptCacheKeySupport === true ? false : promptCacheKeySupport === false ? isResponsesApi : isResponsesApi && usesExplicitProxyLikeEndpoint;
	const supportsResponsesStoreField = readCompatPayloadBoolean(model.compat, "supportsStore") !== false && isResponsesApi;
	return {
		allowsOpenAIServiceTier: provider === "openai" && api === "openai-responses" && endpointClass === "openai-public" || provider === "openai-codex" && (api === "openai-codex-responses" || api === "openai-responses") && endpointClass === "openai-codex",
		allowsResponsesStore: supportsResponsesStoreField && provider !== void 0 && OPENAI_RESPONSES_PROVIDERS.has(provider) && usesKnownNativeOpenAIEndpoint,
		shouldStripResponsesPromptCache,
		supportsResponsesStoreField,
		usesKnownNativeOpenAIRoute
	};
}
function parsePositiveInteger(value) {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	if (typeof value === "string") {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
}
function resolveOpenAIResponsesCompactThreshold(model) {
	const contextWindow = parsePositiveInteger(model.contextWindow);
	if (contextWindow) return Math.max(1e3, Math.floor(contextWindow * .7));
	return 8e4;
}
function shouldEnableOpenAIResponsesServerCompaction(explicitStore, provider, extraParams) {
	const configured = extraParams?.responsesServerCompaction;
	if (configured === false) return false;
	if (explicitStore !== true) return false;
	if (configured === true) return true;
	return provider === "openai";
}
function stripDisabledOpenAIReasoningPayload(payloadObj) {
	const reasoning = payloadObj.reasoning;
	if (reasoning === "none") {
		delete payloadObj.reasoning;
		return;
	}
	if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) return;
	if (reasoning.effort === "none") delete payloadObj.reasoning;
}
function shouldStripAllOpenAIResponsesReasoningPayload(model, capabilities) {
	return normalizeLowercaseString(model.provider) === "xai" && !capabilities.usesKnownNativeOpenAIRoute;
}
function resolveOpenAIResponsesPayloadPolicy(model, options = {}) {
	const capabilities = resolveOpenAIResponsesPayloadCapabilities(model);
	const storeMode = options.storeMode ?? "provider-policy";
	const explicitStore = storeMode === "preserve" ? void 0 : storeMode === "disable" ? capabilities.supportsResponsesStoreField ? false : void 0 : capabilities.allowsResponsesStore ? true : void 0;
	const isResponsesApi = isOpenAIResponsesApi(normalizeLowercaseString(model.api));
	const shouldStripDisabledReasoningPayload = isResponsesApi && (!capabilities.usesKnownNativeOpenAIRoute || !supportsOpenAIReasoningEffort(model, "none"));
	const shouldStripReasoningPayload = isResponsesApi && shouldStripAllOpenAIResponsesReasoningPayload(model, capabilities);
	return {
		allowsServiceTier: capabilities.allowsOpenAIServiceTier,
		compactThreshold: parsePositiveInteger(options.extraParams?.responsesCompactThreshold) ?? resolveOpenAIResponsesCompactThreshold(model),
		explicitStore,
		shouldStripDisabledReasoningPayload,
		shouldStripReasoningPayload,
		shouldStripPromptCache: options.enablePromptCacheStripping === true && capabilities.shouldStripResponsesPromptCache,
		shouldStripStore: explicitStore !== true && readCompatPayloadBoolean(model.compat, "supportsStore") === false && isResponsesApi,
		useServerCompaction: options.enableServerCompaction === true && shouldEnableOpenAIResponsesServerCompaction(explicitStore, model.provider, options.extraParams)
	};
}
function applyOpenAIResponsesPayloadPolicy(payloadObj, policy) {
	if (policy.explicitStore !== void 0) payloadObj.store = policy.explicitStore;
	if (policy.shouldStripStore) delete payloadObj.store;
	if (policy.shouldStripPromptCache) {
		delete payloadObj.prompt_cache_key;
		delete payloadObj.prompt_cache_retention;
	}
	if (policy.shouldStripReasoningPayload) delete payloadObj.reasoning;
	if (policy.useServerCompaction && payloadObj.context_management === void 0) payloadObj.context_management = [{
		type: "compaction",
		compact_threshold: policy.compactThreshold
	}];
	if (policy.shouldStripDisabledReasoningPayload) stripDisabledOpenAIReasoningPayload(payloadObj);
}
//#endregion
//#region src/agents/openai-transport-stream.ts
const DEFAULT_AZURE_OPENAI_API_VERSION = "2024-12-01-preview";
const OPENAI_CODEX_RESPONSES_EMPTY_INPUT_TEXT = " ";
const log = createSubsystemLogger("openai-transport");
function stringifyUnknown(value, fallback = "") {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return fallback;
}
function stringifyJsonLike(value, fallback = "") {
	if (typeof value === "string") return value;
	if (value && typeof value === "object") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return fallback;
}
function getServiceTierCostMultiplier(serviceTier) {
	switch (serviceTier) {
		case "flex": return .5;
		case "priority": return 2;
		default: return 1;
	}
}
function applyServiceTierPricing(usage, serviceTier) {
	const multiplier = getServiceTierCostMultiplier(serviceTier);
	if (multiplier === 1) return;
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
function resolveAzureOpenAIApiVersion(env = process.env) {
	return env.AZURE_OPENAI_API_VERSION?.trim() || DEFAULT_AZURE_OPENAI_API_VERSION;
}
function shortHash(value) {
	let hash = 0;
	for (let i = 0; i < value.length; i += 1) hash = hash * 31 + value.charCodeAt(i) | 0;
	return Math.abs(hash).toString(36);
}
function encodeTextSignatureV1(id, phase) {
	return JSON.stringify({
		v: 1,
		id,
		...phase ? { phase } : {}
	});
}
function parseTextSignature(signature) {
	if (!signature) return;
	if (signature.startsWith("{")) try {
		const parsed = JSON.parse(signature);
		if (parsed.v === 1 && typeof parsed.id === "string") return parsed.phase === "commentary" || parsed.phase === "final_answer" ? {
			id: parsed.id,
			phase: parsed.phase
		} : { id: parsed.id };
	} catch {}
	return { id: signature };
}
function convertResponsesMessages(model, context, allowedToolCallProviders, options) {
	const messages = [];
	const shouldReplayReasoningItems = options?.replayReasoningItems ?? true;
	const shouldReplayResponsesItemIds = options?.replayResponsesItemIds ?? true;
	const normalizeIdPart = (part) => {
		const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
		return (sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized).replace(/_+$/, "");
	};
	const buildForeignResponsesItemId = (itemId) => {
		const normalized = `fc_${shortHash(itemId)}`;
		return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
	};
	const normalizeToolCallId = (id, _targetModel, source) => {
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		if (!id.includes("|")) return normalizeIdPart(id);
		const [callId, itemId] = id.split("|");
		const normalizedCallId = normalizeIdPart(callId);
		let normalizedItemId = source.provider !== model.provider || source.api !== model.api ? buildForeignResponsesItemId(itemId) : normalizeIdPart(itemId);
		if (!normalizedItemId.startsWith("fc_")) normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		return `${normalizedCallId}|${normalizedItemId}`;
	};
	const transformedMessages = transformTransportMessages(context.messages, model, normalizeToolCallId);
	if ((options?.includeSystemPrompt ?? true) && context.systemPrompt) messages.push({
		role: model.reasoning && options?.supportsDeveloperRole !== false ? "developer" : "system",
		content: sanitizeTransportPayloadText(stripSystemPromptCacheBoundary(context.systemPrompt))
	});
	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user") if (typeof msg.content === "string") messages.push({
			role: "user",
			content: [{
				type: "input_text",
				text: sanitizeTransportPayloadText(msg.content)
			}]
		});
		else {
			const content = msg.content.map((item) => item.type === "text" ? {
				type: "input_text",
				text: sanitizeTransportPayloadText(item.text)
			} : {
				type: "input_image",
				detail: "auto",
				image_url: `data:${item.mimeType};base64,${item.data}`
			}).filter((item) => model.input.includes("image") || item.type !== "input_image");
			if (content.length > 0) messages.push({
				role: "user",
				content
			});
		}
		else if (msg.role === "assistant") {
			const output = [];
			const isDifferentModel = msg.model !== model.id && msg.provider === model.provider && msg.api === model.api;
			for (const block of msg.content) if (block.type === "thinking") {
				if (shouldReplayReasoningItems && block.thinkingSignature) {
					const reasoningItem = JSON.parse(block.thinkingSignature);
					if (!shouldReplayResponsesItemIds) delete reasoningItem.id;
					output.push(reasoningItem);
				}
			} else if (block.type === "text") {
				const textSignature = parseTextSignature(block.textSignature);
				let msgId = shouldReplayResponsesItemIds ? textSignature?.id ?? `msg_${msgIndex}` : void 0;
				if (msgId && msgId.length > 64) msgId = `msg_${shortHash(msgId)}`;
				const messageItem = {
					type: "message",
					role: "assistant",
					content: [{
						type: "output_text",
						text: sanitizeTransportPayloadText(block.text),
						annotations: []
					}],
					status: "completed",
					...msgId ? { id: msgId } : {},
					phase: textSignature?.phase
				};
				output.push(messageItem);
			} else if (block.type === "toolCall") {
				const [callId, itemIdRaw] = block.id.split("|");
				const itemId = shouldReplayResponsesItemIds && !(isDifferentModel && itemIdRaw?.startsWith("fc_")) ? itemIdRaw : void 0;
				output.push({
					type: "function_call",
					id: itemId,
					call_id: callId,
					name: block.name,
					arguments: typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {})
				});
			}
			if (output.length > 0) messages.push(...output);
		} else if (msg.role === "toolResult") {
			const textResult = msg.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
			const hasImages = msg.content.some((item) => item.type === "image");
			const [callId] = msg.toolCallId.split("|");
			messages.push({
				type: "function_call_output",
				call_id: callId,
				output: hasImages && model.input.includes("image") ? [...textResult ? [{
					type: "input_text",
					text: sanitizeTransportPayloadText(textResult)
				}] : [], ...msg.content.filter((item) => item.type === "image").map((item) => ({
					type: "input_image",
					detail: "auto",
					image_url: `data:${item.mimeType};base64,${item.data}`
				}))] : sanitizeTransportPayloadText(textResult || "(see attached image)")
			});
		}
		msgIndex += 1;
	}
	return messages;
}
function convertResponsesTools(tools, model, options) {
	const strict = resolveOpenAIStrictToolFlagWithDiagnostics(tools, options?.strict, {
		transport: "responses",
		model
	});
	return tools.map((tool) => {
		const base = {
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: normalizeOpenAIStrictToolParameters(tool.parameters, strict === true)
		};
		return strict === void 0 ? base : {
			...base,
			strict
		};
	});
}
function resolveOpenAIStrictToolFlagWithDiagnostics(tools, strictSetting, context) {
	const strict = resolveOpenAIStrictToolFlagForInventory(tools, strictSetting);
	if (strictSetting === true && strict === false && log.isEnabled("debug", "any")) {
		const diagnostics = findOpenAIStrictToolSchemaDiagnostics(tools);
		const sample = diagnostics.slice(0, 5).map((entry) => ({
			tool: entry.toolName ?? `tool[${entry.toolIndex}]`,
			violations: entry.violations.slice(0, 8)
		}));
		log.debug(`OpenAI ${context.transport} tool schema strict mode downgraded to strict=false for ${context.model.provider ?? "unknown"}/${context.model.id ?? "unknown"} because ${diagnostics.length} tool schema(s) are not strict-compatible`, {
			transport: context.transport,
			provider: context.model.provider,
			model: context.model.id,
			incompatibleToolCount: diagnostics.length,
			sample
		});
	}
	return strict;
}
async function processResponsesStream(openaiStream, output, stream, model, options) {
	let currentItem = null;
	let currentBlock = null;
	const blockIndex = () => output.content.length - 1;
	for await (const rawEvent of openaiStream) {
		const event = rawEvent;
		const type = stringifyUnknown(event.type);
		if (type === "response.created") output.responseId = stringifyUnknown(event.response?.id);
		else if (type === "response.output_item.added") {
			const item = event.item;
			if (item.type === "reasoning") {
				currentItem = item;
				currentBlock = {
					type: "thinking",
					thinking: ""
				};
				output.content.push(currentBlock);
				stream.push({
					type: "thinking_start",
					contentIndex: blockIndex(),
					partial: output
				});
			} else if (item.type === "message") {
				currentItem = item;
				currentBlock = {
					type: "text",
					text: ""
				};
				output.content.push(currentBlock);
				stream.push({
					type: "text_start",
					contentIndex: blockIndex(),
					partial: output
				});
			} else if (item.type === "function_call") {
				currentItem = item;
				currentBlock = {
					type: "toolCall",
					id: `${stringifyUnknown(item.call_id)}|${stringifyUnknown(item.id)}`,
					name: stringifyUnknown(item.name),
					arguments: {},
					partialJson: stringifyJsonLike(item.arguments)
				};
				output.content.push(currentBlock);
				stream.push({
					type: "toolcall_start",
					contentIndex: blockIndex(),
					partial: output
				});
			}
		} else if (type === "response.reasoning_summary_text.delta") {
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
				currentBlock.thinking = `${stringifyUnknown(currentBlock.thinking)}${stringifyUnknown(event.delta)}`;
				stream.push({
					type: "thinking_delta",
					contentIndex: blockIndex(),
					delta: stringifyUnknown(event.delta),
					partial: output
				});
			}
		} else if (type === "response.output_text.delta" || type === "response.refusal.delta") {
			if (currentItem?.type === "message" && currentBlock?.type === "text") {
				currentBlock.text = `${stringifyUnknown(currentBlock.text)}${stringifyUnknown(event.delta)}`;
				stream.push({
					type: "text_delta",
					contentIndex: blockIndex(),
					delta: stringifyUnknown(event.delta),
					partial: output
				});
			}
		} else if (type === "response.function_call_arguments.delta") {
			if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
				currentBlock.partialJson = `${stringifyJsonLike(currentBlock.partialJson)}${stringifyJsonLike(event.delta)}`;
				currentBlock.arguments = parseStreamingJson(stringifyJsonLike(currentBlock.partialJson));
				stream.push({
					type: "toolcall_delta",
					contentIndex: blockIndex(),
					delta: stringifyJsonLike(event.delta),
					partial: output
				});
			}
		} else if (type === "response.output_item.done") {
			const item = event.item;
			if (item.type === "reasoning" && currentBlock?.type === "thinking") {
				const summary = Array.isArray(item.summary) ? item.summary.map((part) => {
					return part.text ?? "";
				}).join("\n\n") : "";
				currentBlock.thinking = summary;
				currentBlock.thinkingSignature = JSON.stringify(item);
				stream.push({
					type: "thinking_end",
					contentIndex: blockIndex(),
					content: stringifyUnknown(currentBlock.thinking),
					partial: output
				});
				currentBlock = null;
			} else if (item.type === "message" && currentBlock?.type === "text") {
				const content = Array.isArray(item.content) ? item.content : [];
				currentBlock.text = content.map((part) => {
					const contentPart = part;
					return contentPart.type === "output_text" ? contentPart.text ?? "" : contentPart.refusal ?? "";
				}).join("");
				currentBlock.textSignature = encodeTextSignatureV1(stringifyUnknown(item.id), item.phase ?? void 0);
				stream.push({
					type: "text_end",
					contentIndex: blockIndex(),
					content: stringifyUnknown(currentBlock.text),
					partial: output
				});
				currentBlock = null;
			} else if (item.type === "function_call") {
				const args = currentBlock?.type === "toolCall" && currentBlock.partialJson ? parseStreamingJson(stringifyJsonLike(currentBlock.partialJson, "{}")) : parseStreamingJson(stringifyJsonLike(item.arguments, "{}"));
				stream.push({
					type: "toolcall_end",
					contentIndex: blockIndex(),
					toolCall: {
						type: "toolCall",
						id: `${stringifyUnknown(item.call_id)}|${stringifyUnknown(item.id)}`,
						name: stringifyUnknown(item.name),
						arguments: args
					},
					partial: output
				});
				currentBlock = null;
			}
		} else if (type === "response.completed") {
			const response = event.response;
			if (typeof response?.id === "string") output.responseId = response.id;
			const usage = response?.usage;
			if (usage) {
				const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
				output.usage = {
					input: (usage.input_tokens || 0) - cachedTokens,
					output: usage.output_tokens || 0,
					cacheRead: cachedTokens,
					cacheWrite: 0,
					totalTokens: usage.total_tokens || 0,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0
					}
				};
			}
			calculateCost(model, output.usage);
			if (options?.applyServiceTierPricing) options.applyServiceTierPricing(output.usage, response?.service_tier ?? options.serviceTier);
			output.stopReason = mapResponsesStopReason(response?.status);
			if (output.content.some((block) => block.type === "toolCall") && output.stopReason === "stop") output.stopReason = "toolUse";
		} else if (type === "error") throw new Error(`Error Code ${stringifyUnknown(event.code, "unknown")}: ${stringifyUnknown(event.message, "Unknown error")}`);
		else if (type === "response.failed") {
			const response = event.response;
			const msg = response?.error ? `${response.error.code || "unknown"}: ${response.error.message || "no message"}` : response?.incomplete_details?.reason ? `incomplete: ${response.incomplete_details.reason}` : "Unknown error (no error details in response)";
			throw new Error(msg);
		}
	}
}
function mapResponsesStopReason(status) {
	if (!status) return "stop";
	switch (status) {
		case "completed": return "stop";
		case "incomplete": return "length";
		case "failed":
		case "cancelled": return "error";
		case "in_progress":
		case "queued": return "stop";
		default: throw new Error(`Unhandled stop reason: ${status}`);
	}
}
function buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders) {
	const providerHeaders = { ...model.headers };
	if (model.provider === "github-copilot") Object.assign(providerHeaders, buildCopilotDynamicHeaders({
		messages: context.messages,
		hasImages: hasCopilotVisionInput(context.messages)
	}));
	const callerHeaders = {
		...optionHeaders,
		...turnHeaders
	};
	return resolveProviderRequestPolicyConfig({
		provider: model.provider,
		api: model.api,
		baseUrl: model.baseUrl,
		capability: "llm",
		transport: "stream",
		providerHeaders,
		callerHeaders: Object.keys(callerHeaders).length > 0 ? callerHeaders : void 0,
		precedence: "caller-wins"
	}).headers ?? {};
}
function resolveProviderTransportTurnState(model, params) {
	return resolveProviderTransportTurnStateWithPlugin({
		provider: model.provider,
		context: {
			provider: model.provider,
			modelId: model.id,
			model,
			sessionId: params.sessionId,
			turnId: params.turnId,
			attempt: params.attempt,
			transport: params.transport
		}
	});
}
function resolveOpenAISdkTimeoutMs(model) {
	return resolveModelRequestTimeoutMs(model, void 0);
}
function buildOpenAISdkClientOptions(model) {
	const timeout = resolveOpenAISdkTimeoutMs(model);
	return timeout === void 0 ? {} : { timeout };
}
function buildOpenAISdkRequestOptions(model, signal) {
	const timeout = resolveOpenAISdkTimeoutMs(model);
	if (timeout === void 0 && !signal) return;
	return {
		...signal ? { signal } : {},
		...timeout !== void 0 ? { timeout } : {}
	};
}
function createOpenAIResponsesClient(model, context, apiKey, optionHeaders, turnHeaders) {
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders),
		fetch: buildGuardedModelFetch(model),
		...buildOpenAISdkClientOptions(model)
	});
}
function createOpenAIResponsesTransportStreamFn() {
	return (model, context, options) => {
		const eventStream = createAssistantMessageEventStream();
		const stream = eventStream;
		(async () => {
			const output = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0
					}
				},
				stopReason: "stop",
				timestamp: Date.now()
			};
			try {
				const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
				const turnState = resolveProviderTransportTurnState(model, {
					sessionId: options?.sessionId,
					turnId: randomUUID(),
					attempt: 1,
					transport: "stream"
				});
				const client = createOpenAIResponsesClient(model, context, apiKey, options?.headers, turnState?.headers);
				let params = buildOpenAIResponsesParams(model, context, options, turnState?.metadata);
				const nextParams = await options?.onPayload?.(params, model);
				if (nextParams !== void 0) params = nextParams;
				if (!isOpenAICodexResponsesModel(model)) params = mergeTransportMetadata(params, turnState?.metadata);
				params = sanitizeOpenAICodexResponsesParams(model, params);
				const responseStream = await client.responses.create(params, buildOpenAISdkRequestOptions(model, options?.signal));
				stream.push({
					type: "start",
					partial: output
				});
				await processResponsesStream(responseStream, output, stream, model, {
					serviceTier: options?.serviceTier,
					applyServiceTierPricing
				});
				if (options?.signal?.aborted) throw new Error("Request was aborted");
				if (output.stopReason === "aborted" || output.stopReason === "error") throw new Error("An unknown error occurred");
				stream.push({
					type: "done",
					reason: output.stopReason,
					message: output
				});
				stream.end();
			} catch (error) {
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
				stream.push({
					type: "error",
					reason: output.stopReason,
					error: output
				});
				stream.end();
			}
		})();
		return eventStream;
	};
}
function resolveCacheRetention(cacheRetention) {
	if (cacheRetention === "short" || cacheRetention === "long" || cacheRetention === "none") return cacheRetention;
	if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") return "long";
	return "short";
}
function getPromptCacheRetention(baseUrl, cacheRetention) {
	if (cacheRetention !== "long") return;
	return baseUrl?.includes("api.openai.com") ? "24h" : void 0;
}
function resolveOpenAIReasoningEffort(options) {
	return normalizeOpenAIReasoningEffort(options?.reasoningEffort ?? options?.reasoning ?? "high");
}
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function hasResponsesWebSearchTool(tools) {
	if (!Array.isArray(tools)) return false;
	return tools.some((tool) => {
		if (!isRecord(tool)) return false;
		if (tool.type === "web_search") return true;
		if (tool.type === "function" && tool.name === "web_search") return true;
		const fn = tool.function;
		return isRecord(fn) && fn.name === "web_search";
	});
}
function raiseMinimalReasoningForResponsesWebSearch(params) {
	if (params.effort !== "minimal" || !hasResponsesWebSearchTool(params.tools)) return params.effort;
	for (const effort of [
		"low",
		"medium",
		"high"
	]) {
		const resolved = resolveOpenAIReasoningEffortForModel({
			model: params.model,
			effort
		});
		if (resolved && resolved !== "none" && resolved !== "minimal") return resolved;
	}
	return params.effort;
}
function isOpenAICodexResponsesModel(model) {
	return model.provider === "openai-codex" && model.api === "openai-codex-responses";
}
function isNativeOpenAICodexResponsesBaseUrl(baseUrl) {
	const trimmed = typeof baseUrl === "string" ? baseUrl.trim() : "";
	if (!trimmed) return false;
	try {
		const url = new URL(trimmed);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		if (url.hostname.toLowerCase() !== "chatgpt.com") return false;
		const pathname = url.pathname.replace(/\/+$/u, "").toLowerCase();
		return [
			"/backend-api",
			"/backend-api/v1",
			"/backend-api/codex",
			"/backend-api/codex/v1"
		].includes(pathname);
	} catch {
		return false;
	}
}
function usesNativeOpenAICodexResponsesBackend(model) {
	return isOpenAICodexResponsesModel(model) && isNativeOpenAICodexResponsesBaseUrl(model.baseUrl);
}
const OPENAI_CODEX_RESPONSES_UNSUPPORTED_PARAMS = [
	"max_output_tokens",
	"metadata",
	"prompt_cache_retention",
	"service_tier",
	"temperature"
];
function sanitizeOpenAICodexResponsesParams(model, params) {
	if (!usesNativeOpenAICodexResponsesBackend(model)) return params;
	for (const key of OPENAI_CODEX_RESPONSES_UNSUPPORTED_PARAMS) delete params[key];
	return params;
}
function buildOpenAICodexResponsesInstructions(context) {
	if (!context.systemPrompt) return;
	return sanitizeTransportPayloadText(stripSystemPromptCacheBoundary(context.systemPrompt));
}
function ensureOpenAICodexResponsesInput(messages, context) {
	if (messages.length > 0 || !context.systemPrompt) return;
	if (!buildOpenAICodexResponsesInstructions(context)) throw new Error("OpenAI Codex Responses requires non-empty input when only systemPrompt is provided.");
	messages.push({
		role: "user",
		content: [{
			type: "input_text",
			text: OPENAI_CODEX_RESPONSES_EMPTY_INPUT_TEXT
		}]
	});
}
function buildOpenAIResponsesParams(model, context, options, metadata) {
	const isCodexResponses = isOpenAICodexResponsesModel(model);
	const isNativeCodexResponses = usesNativeOpenAICodexResponsesBackend(model);
	const compat = getCompat(model);
	const supportsDeveloperRole = typeof compat.supportsDeveloperRole === "boolean" ? compat.supportsDeveloperRole : void 0;
	const messages = convertResponsesMessages(model, context, new Set([
		"openai",
		"openai-codex",
		"opencode",
		"azure-openai-responses"
	]), {
		includeSystemPrompt: !isCodexResponses,
		supportsDeveloperRole,
		replayReasoningItems: true,
		replayResponsesItemIds: !isNativeCodexResponses
	});
	if (isCodexResponses) ensureOpenAICodexResponsesInput(messages, context);
	const cacheRetention = resolveCacheRetention(options?.cacheRetention);
	const payloadPolicy = resolveOpenAIResponsesPayloadPolicy(model, { storeMode: "disable" });
	const params = {
		model: model.id,
		input: messages,
		stream: true,
		prompt_cache_key: cacheRetention === "none" ? void 0 : options?.sessionId,
		prompt_cache_retention: getPromptCacheRetention(model.baseUrl, cacheRetention),
		...isCodexResponses ? { instructions: buildOpenAICodexResponsesInstructions(context) } : {},
		...metadata ? { metadata } : {}
	};
	const effectiveMaxTokens = options?.maxTokens || model.maxTokens;
	if (effectiveMaxTokens) params.max_output_tokens = effectiveMaxTokens;
	if (options?.temperature !== void 0) params.temperature = options.temperature;
	if (options?.serviceTier !== void 0 && payloadPolicy.allowsServiceTier) params.service_tier = options.serviceTier;
	if (context.tools) params.tools = convertResponsesTools(context.tools, model, { strict: resolveOpenAIStrictToolSetting(model, { transport: "stream" }) });
	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoning || options?.reasoningSummary) {
			const resolvedReasoningEffort = resolveOpenAIReasoningEffortForModel({
				model,
				effort: resolveOpenAIReasoningEffort(options)
			});
			const reasoningEffort = resolvedReasoningEffort ? raiseMinimalReasoningForResponsesWebSearch({
				model,
				effort: resolvedReasoningEffort,
				tools: params.tools
			}) : void 0;
			if (reasoningEffort) {
				params.reasoning = {
					effort: reasoningEffort,
					...reasoningEffort === "none" ? {} : { summary: options?.reasoningSummary || "auto" }
				};
				if (reasoningEffort !== "none") params.include = ["reasoning.encrypted_content"];
			}
		} else if (model.provider !== "github-copilot") {
			const reasoningEffort = resolveOpenAIReasoningEffortForModel({
				model,
				effort: "none"
			});
			if (reasoningEffort) params.reasoning = { effort: reasoningEffort };
		}
	}
	applyOpenAIResponsesPayloadPolicy(params, payloadPolicy);
	return sanitizeOpenAICodexResponsesParams(model, params);
}
function createAzureOpenAIResponsesTransportStreamFn() {
	return (model, context, options) => {
		const eventStream = createAssistantMessageEventStream();
		const stream = eventStream;
		(async () => {
			const output = {
				role: "assistant",
				content: [],
				api: "azure-openai-responses",
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0
					}
				},
				stopReason: "stop",
				timestamp: Date.now()
			};
			try {
				const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
				const turnState = resolveProviderTransportTurnState(model, {
					sessionId: options?.sessionId,
					turnId: randomUUID(),
					attempt: 1,
					transport: "stream"
				});
				const client = createAzureOpenAIClient(model, context, apiKey, options?.headers, turnState?.headers);
				let params = buildAzureOpenAIResponsesParams(model, context, options, resolveAzureDeploymentName(model), turnState?.metadata);
				const nextParams = await options?.onPayload?.(params, model);
				if (nextParams !== void 0) params = nextParams;
				if (!isOpenAICodexResponsesModel(model)) params = mergeTransportMetadata(params, turnState?.metadata);
				params = sanitizeOpenAICodexResponsesParams(model, params);
				const responseStream = await client.responses.create(params, buildOpenAISdkRequestOptions(model, options?.signal));
				stream.push({
					type: "start",
					partial: output
				});
				await processResponsesStream(responseStream, output, stream, model);
				if (options?.signal?.aborted) throw new Error("Request was aborted");
				if (output.stopReason === "aborted" || output.stopReason === "error") throw new Error("An unknown error occurred");
				stream.push({
					type: "done",
					reason: output.stopReason,
					message: output
				});
				stream.end();
			} catch (error) {
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
				stream.push({
					type: "error",
					reason: output.stopReason,
					error: output
				});
				stream.end();
			}
		})();
		return eventStream;
	};
}
function normalizeAzureBaseUrl(baseUrl) {
	return baseUrl.replace(/\/+$/, "");
}
function resolveAzureDeploymentName(model) {
	const deploymentMap = process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
	if (deploymentMap) for (const entry of deploymentMap.split(",")) {
		const [modelId, deploymentName] = entry.split("=", 2).map((value) => value?.trim());
		if (modelId === model.id && deploymentName) return deploymentName;
	}
	return model.id;
}
function createAzureOpenAIClient(model, context, apiKey, optionHeaders, turnHeaders) {
	return new AzureOpenAI({
		apiKey,
		apiVersion: resolveAzureOpenAIApiVersion(),
		dangerouslyAllowBrowser: true,
		defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders),
		baseURL: normalizeAzureBaseUrl(model.baseUrl),
		fetch: buildGuardedModelFetch(model),
		...buildOpenAISdkClientOptions(model)
	});
}
function buildAzureOpenAIResponsesParams(model, context, options, deploymentName, metadata) {
	const params = buildOpenAIResponsesParams(model, context, options, metadata);
	params.model = deploymentName;
	delete params.store;
	return params;
}
function hasToolHistory(messages) {
	return messages.some((message) => message.role === "toolResult" || message.role === "assistant" && message.content.some((block) => block.type === "toolCall"));
}
function createOpenAICompletionsClient(model, context, apiKey, optionHeaders) {
	const clientConfig = buildOpenAICompletionsClientConfig(model, context, optionHeaders);
	return new OpenAI({
		apiKey,
		baseURL: clientConfig.baseURL,
		dangerouslyAllowBrowser: true,
		defaultHeaders: clientConfig.defaultHeaders,
		defaultQuery: clientConfig.defaultQuery,
		fetch: buildGuardedModelFetch(model),
		...buildOpenAISdkClientOptions(model)
	});
}
function isAzureOpenAICompatibleHost(hostname) {
	return hostname.endsWith(".openai.azure.com") || hostname.endsWith(".services.ai.azure.com") || hostname.endsWith(".cognitiveservices.azure.com");
}
function buildOpenAICompletionsClientConfig(model, context, optionHeaders) {
	const headers = buildOpenAIClientHeaders(model, context, optionHeaders);
	const defaultQuery = {};
	let baseURL = model.baseUrl;
	let isAzureHost = false;
	try {
		const parsed = new URL(model.baseUrl);
		isAzureHost = isAzureOpenAICompatibleHost(parsed.hostname.toLowerCase());
		parsed.searchParams.forEach((value, key) => {
			if (value) defaultQuery[key] = value;
		});
		parsed.search = "";
		baseURL = parsed.toString().replace(/\/$/, "");
	} catch {}
	if (isAzureHost) {
		const apiVersionHeader = Object.keys(headers).find((key) => key.toLowerCase() === "api-version");
		if (apiVersionHeader) {
			const apiVersion = headers[apiVersionHeader]?.trim();
			delete headers[apiVersionHeader];
			if (apiVersion && !defaultQuery["api-version"]) defaultQuery["api-version"] = apiVersion;
		}
	}
	return {
		baseURL,
		defaultHeaders: headers,
		defaultQuery: Object.keys(defaultQuery).length > 0 ? defaultQuery : void 0
	};
}
function createOpenAICompletionsTransportStreamFn() {
	return (model, context, options) => {
		const eventStream = createAssistantMessageEventStream();
		const stream = eventStream;
		(async () => {
			const output = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0
					}
				},
				stopReason: "stop",
				timestamp: Date.now()
			};
			try {
				const client = createOpenAICompletionsClient(model, context, options?.apiKey || getEnvApiKey(model.provider) || "", options?.headers);
				let params = buildOpenAICompletionsParams(model, context, options);
				const nextParams = await options?.onPayload?.(params, model);
				if (nextParams !== void 0) params = nextParams;
				const responseStream = await client.chat.completions.create(params, buildOpenAISdkRequestOptions(model, options?.signal));
				stream.push({
					type: "start",
					partial: output
				});
				await processOpenAICompletionsStream(responseStream, output, model, stream);
				if (options?.signal?.aborted) throw new Error("Request was aborted");
				stream.push({
					type: "done",
					reason: output.stopReason,
					message: output
				});
				stream.end();
			} catch (error) {
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
				stream.push({
					type: "error",
					reason: output.stopReason,
					error: output
				});
				stream.end();
			}
		})();
		return eventStream;
	};
}
async function processOpenAICompletionsStream(responseStream, output, model, stream) {
	const MAX_POST_TOOL_CALL_BUFFER_BYTES = 256e3;
	const MAX_TOOL_CALL_ARGUMENT_BUFFER_BYTES = 256e3;
	const compat = getCompat(model);
	let currentBlock = null;
	let pendingPostToolCallDeltas = [];
	let pendingPostToolCallBytes = 0;
	let currentToolCallArgumentBytes = 0;
	let isFlushingPendingPostToolCallDeltas = false;
	const blockIndex = () => output.content.length - 1;
	const measureUtf8Bytes = (text) => Buffer.byteLength(text, "utf8");
	const finishCurrentBlock = () => {
		if (!currentBlock) return;
		if (currentBlock.type === "toolCall") {
			currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
			const completed = {
				...currentBlock,
				arguments: parseStreamingJson(currentBlock.partialArgs)
			};
			output.content[blockIndex()] = completed;
		}
	};
	const queuePostToolCallDelta = (next) => {
		const nextBytes = measureUtf8Bytes(next.text);
		if (pendingPostToolCallBytes + nextBytes > MAX_POST_TOOL_CALL_BUFFER_BYTES) throw new Error("Exceeded post-tool-call delta buffer limit");
		pendingPostToolCallBytes += nextBytes;
		const previous = pendingPostToolCallDeltas[pendingPostToolCallDeltas.length - 1];
		if (!previous || previous.kind !== next.kind) {
			pendingPostToolCallDeltas.push(next);
			return;
		}
		if (next.kind === "thinking" && previous.kind === "thinking") {
			if (previous.signature !== next.signature) {
				pendingPostToolCallDeltas.push(next);
				return;
			}
			previous.text += next.text;
			return;
		}
		previous.text += next.text;
	};
	const appendThinkingDeltaInternal = (reasoningDelta) => {
		if (!currentBlock || currentBlock.type !== "thinking") {
			finishCurrentBlock();
			currentBlock = {
				type: "thinking",
				thinking: "",
				thinkingSignature: reasoningDelta.signature
			};
			output.content.push(currentBlock);
			stream.push({
				type: "thinking_start",
				contentIndex: blockIndex(),
				partial: output
			});
		}
		currentBlock.thinking += reasoningDelta.text;
		stream.push({
			type: "thinking_delta",
			contentIndex: blockIndex(),
			delta: reasoningDelta.text,
			partial: output
		});
	};
	const appendTextDeltaInternal = (text) => {
		if (!currentBlock || currentBlock.type !== "text") {
			finishCurrentBlock();
			currentBlock = {
				type: "text",
				text: ""
			};
			output.content.push(currentBlock);
			stream.push({
				type: "text_start",
				contentIndex: blockIndex(),
				partial: output
			});
		}
		currentBlock.text += text;
		stream.push({
			type: "text_delta",
			contentIndex: blockIndex(),
			delta: text,
			partial: output
		});
	};
	const flushPendingPostToolCallDeltas = () => {
		if (isFlushingPendingPostToolCallDeltas || currentBlock?.type === "toolCall" || pendingPostToolCallDeltas.length === 0) return;
		isFlushingPendingPostToolCallDeltas = true;
		const bufferedDeltas = pendingPostToolCallDeltas;
		pendingPostToolCallDeltas = [];
		pendingPostToolCallBytes = 0;
		for (const delta of bufferedDeltas) if (delta.kind === "text") appendTextDeltaInternal(delta.text);
		else appendThinkingDeltaInternal(delta);
		isFlushingPendingPostToolCallDeltas = false;
	};
	const appendThinkingDelta = (reasoningDelta) => {
		flushPendingPostToolCallDeltas();
		appendThinkingDeltaInternal(reasoningDelta);
	};
	const appendTextDelta = (text) => {
		flushPendingPostToolCallDeltas();
		appendTextDeltaInternal(text);
	};
	for await (const rawChunk of responseStream) {
		if (!rawChunk || typeof rawChunk !== "object") continue;
		const chunk = rawChunk;
		output.responseId ||= chunk.id;
		if (chunk.usage) output.usage = parseTransportChunkUsage(chunk.usage, model);
		const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : void 0;
		if (!choice) continue;
		const choiceUsage = choice.usage;
		if (!chunk.usage && choiceUsage) output.usage = parseTransportChunkUsage(choiceUsage, model);
		if (choice.finish_reason) {
			const finishReasonResult = mapStopReason(choice.finish_reason);
			output.stopReason = finishReasonResult.stopReason;
			if (finishReasonResult.errorMessage) output.errorMessage = finishReasonResult.errorMessage;
		}
		if (!choice.delta) continue;
		if (choice.delta.content) {
			if (currentBlock?.type === "toolCall") queuePostToolCallDelta({
				kind: "text",
				text: choice.delta.content
			});
			else appendTextDelta(choice.delta.content);
			continue;
		}
		const reasoningDeltas = getCompletionsReasoningDeltas(choice.delta, compat.visibleReasoningDetailTypes);
		for (const reasoningDelta of reasoningDeltas) {
			if (currentBlock?.type === "toolCall") {
				queuePostToolCallDelta({ ...reasoningDelta });
				continue;
			}
			if (reasoningDelta.kind === "text") appendTextDelta(reasoningDelta.text);
			else appendThinkingDelta(reasoningDelta);
		}
		if (choice.delta.tool_calls && choice.delta.tool_calls.length > 0) for (const toolCall of choice.delta.tool_calls) {
			if (!currentBlock || currentBlock.type !== "toolCall" || toolCall.id && currentBlock.id !== toolCall.id) {
				const switchingToolCall = currentBlock?.type === "toolCall";
				finishCurrentBlock();
				if (switchingToolCall) {
					currentBlock = null;
					flushPendingPostToolCallDeltas();
				}
				const initialSig = extractGoogleThoughtSignature(toolCall);
				currentBlock = {
					type: "toolCall",
					id: toolCall.id || "",
					name: toolCall.function?.name || "",
					arguments: {},
					partialArgs: "",
					...initialSig ? { thoughtSignature: initialSig } : {}
				};
				currentToolCallArgumentBytes = 0;
				output.content.push(currentBlock);
				stream.push({
					type: "toolcall_start",
					contentIndex: blockIndex(),
					partial: output
				});
			}
			if (currentBlock.type !== "toolCall") continue;
			if (toolCall.id) currentBlock.id = toolCall.id;
			if (toolCall.function?.name) currentBlock.name = toolCall.function.name;
			const deltaSig = extractGoogleThoughtSignature(toolCall);
			if (deltaSig) currentBlock.thoughtSignature = deltaSig;
			if (toolCall.function?.arguments) {
				const nextArgumentBytes = measureUtf8Bytes(toolCall.function.arguments);
				if (currentToolCallArgumentBytes + nextArgumentBytes > MAX_TOOL_CALL_ARGUMENT_BUFFER_BYTES) throw new Error("Exceeded tool-call argument buffer limit");
				currentToolCallArgumentBytes += nextArgumentBytes;
				currentBlock.partialArgs += toolCall.function.arguments;
				currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
				stream.push({
					type: "toolcall_delta",
					contentIndex: blockIndex(),
					delta: toolCall.function.arguments,
					partial: output
				});
			}
		}
		flushPendingPostToolCallDeltas();
	}
	finishCurrentBlock();
	if (currentBlock?.type === "toolCall") currentBlock = null;
	flushPendingPostToolCallDeltas();
	const hasToolCalls = output.content.some((block) => block.type === "toolCall");
	if (output.stopReason === "toolUse" && !hasToolCalls) output.stopReason = "stop";
}
function getCompletionsReasoningDeltas(delta, visibleReasoningDetailTypes) {
	const output = [];
	const pushDelta = (next) => {
		const previous = output[output.length - 1];
		if (!previous || previous.kind !== next.kind) {
			output.push(next);
			return;
		}
		if (next.kind === "thinking" && previous.kind === "thinking") {
			if (previous.signature !== next.signature) {
				output.push(next);
				return;
			}
			previous.text += next.text;
			return;
		}
		previous.text += next.text;
	};
	const reasoningDetails = delta.reasoning_details;
	let usedReasoningThinkingDetails = false;
	if (Array.isArray(reasoningDetails)) {
		const visibleTypes = new Set(visibleReasoningDetailTypes);
		for (const item of reasoningDetails) {
			const detail = item;
			if (typeof detail.text !== "string" || !detail.text) continue;
			if (detail.type === "reasoning.text") {
				usedReasoningThinkingDetails = true;
				pushDelta({
					kind: "thinking",
					signature: "reasoning_details",
					text: detail.text
				});
				continue;
			}
			if (typeof detail.type === "string" && visibleTypes.has(detail.type)) pushDelta({
				kind: "text",
				text: detail.text
			});
		}
	}
	if (!usedReasoningThinkingDetails) for (const field of [
		"reasoning_content",
		"reasoning",
		"reasoning_text"
	]) {
		const value = delta[field];
		if (typeof value === "string" && value.length > 0) {
			pushDelta({
				kind: "thinking",
				signature: field,
				text: value
			});
			break;
		}
	}
	return output;
}
function detectCompat(model) {
	const { defaults: compatDefaults } = detectOpenAICompletionsCompat(model);
	return {
		supportsStore: compatDefaults.supportsStore,
		supportsDeveloperRole: compatDefaults.supportsDeveloperRole,
		supportsReasoningEffort: compatDefaults.supportsReasoningEffort,
		reasoningEffortMap: {},
		supportsUsageInStreaming: compatDefaults.supportsUsageInStreaming,
		maxTokensField: compatDefaults.maxTokensField,
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		thinkingFormat: compatDefaults.thinkingFormat,
		visibleReasoningDetailTypes: compatDefaults.visibleReasoningDetailTypes,
		openRouterRouting: {},
		vercelGatewayRouting: {},
		supportsStrictMode: compatDefaults.supportsStrictMode
	};
}
function getCompat(model) {
	const detected = detectCompat(model);
	const compat = model.compat ?? {};
	const supportsStore = typeof compat.supportsStore === "boolean" ? compat.supportsStore : detected.supportsStore;
	const supportsReasoningEffort = typeof compat.supportsReasoningEffort === "boolean" ? compat.supportsReasoningEffort : detected.supportsReasoningEffort;
	return {
		supportsStore,
		supportsDeveloperRole: compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
		supportsReasoningEffort,
		reasoningEffortMap: resolveOpenAIReasoningEffortMap(model, detected.reasoningEffortMap),
		supportsUsageInStreaming: compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
		maxTokensField: compat.maxTokensField ?? detected.maxTokensField,
		requiresToolResultName: compat.requiresToolResultName ?? detected.requiresToolResultName,
		requiresAssistantAfterToolResult: compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
		requiresThinkingAsText: compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
		thinkingFormat: compat.thinkingFormat ?? detected.thinkingFormat,
		openRouterRouting: compat.openRouterRouting ?? {},
		vercelGatewayRouting: compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
		supportsStrictMode: compat.supportsStrictMode ?? detected.supportsStrictMode,
		supportsPromptCacheKey: compat.supportsPromptCacheKey === true,
		requiresStringContent: compat.requiresStringContent ?? false,
		visibleReasoningDetailTypes: compat.visibleReasoningDetailTypes ?? detected.visibleReasoningDetailTypes
	};
}
function resolveOpenAICompletionsReasoningEffort(options) {
	return options?.reasoningEffort ?? options?.reasoning ?? "high";
}
function convertTools(tools, compat, model) {
	const strict = resolveOpenAIStrictToolFlagWithDiagnostics(tools, resolveOpenAIStrictToolSetting(model, {
		transport: "stream",
		supportsStrictMode: compat?.supportsStrictMode
	}), {
		transport: "completions",
		model
	});
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: normalizeOpenAIStrictToolParameters(tool.parameters, strict === true),
			...strict === void 0 ? {} : { strict }
		}
	}));
}
function extractGoogleThoughtSignature(toolCall) {
	const tc = toolCall;
	if (!tc) return;
	const fromExtra = (tc.extra_content?.google)?.thought_signature;
	if (typeof fromExtra === "string" && fromExtra.length > 0) return fromExtra;
	const fromFunction = tc.function?.thought_signature;
	return typeof fromFunction === "string" && fromFunction.length > 0 ? fromFunction : void 0;
}
function isGoogleOpenAICompatModel(model) {
	const endpointClass = detectOpenAICompletionsCompat(model).capabilities.endpointClass;
	return model.provider === "google" || endpointClass === "google-generative-ai" || endpointClass === "google-vertex";
}
function injectToolCallThoughtSignatures(outgoingMessages, context, model) {
	if (!isGoogleOpenAICompatModel(model)) return;
	const sigById = /* @__PURE__ */ new Map();
	for (const msg of context.messages ?? []) {
		if (msg.role !== "assistant") continue;
		const source = msg;
		if (source.api !== model.api || source.provider !== model.provider || source.model !== model.id) continue;
		if (!Array.isArray(source.content)) continue;
		for (const block of source.content) {
			if (block.type !== "toolCall") continue;
			const id = block.id;
			const sig = block.thoughtSignature;
			if (typeof id === "string" && typeof sig === "string" && sig.length > 0) sigById.set(id, sig);
		}
	}
	if (sigById.size === 0) return;
	for (const message of outgoingMessages) {
		const toolCalls = message.tool_calls;
		if (!Array.isArray(toolCalls)) continue;
		for (const toolCall of toolCalls) {
			const id = toolCall.id;
			if (typeof id !== "string") continue;
			const sig = sigById.get(id);
			if (!sig) continue;
			const extra = toolCall.extra_content && typeof toolCall.extra_content === "object" ? toolCall.extra_content : {};
			toolCall.extra_content = extra;
			const google = extra.google && typeof extra.google === "object" ? extra.google : {};
			extra.google = google;
			google.thought_signature = sig;
		}
	}
}
function buildOpenAICompletionsParams(model, context, options) {
	const compat = getCompat(model);
	const compatDetection = detectOpenAICompletionsCompat(model);
	const messages = convertMessages(model, context.systemPrompt ? {
		...context,
		systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt)
	} : context, compat);
	injectToolCallThoughtSignatures(messages, context, model);
	const cacheRetention = resolveCacheRetention(options?.cacheRetention);
	const params = {
		model: model.id,
		messages: compat.requiresStringContent ? flattenCompletionMessagesToStringContent(messages) : messages,
		stream: true,
		stream_options: { include_usage: true }
	};
	if (compat.supportsStore) params.store = false;
	if (compat.supportsPromptCacheKey && cacheRetention !== "none" && options?.sessionId) params.prompt_cache_key = options.sessionId;
	{
		const effectiveMaxTokens = options?.maxTokens || model.maxTokens;
		if (effectiveMaxTokens) if (compat.maxTokensField === "max_tokens") params.max_tokens = effectiveMaxTokens;
		else params.max_completion_tokens = effectiveMaxTokens;
	}
	if (options?.temperature !== void 0) params.temperature = options.temperature;
	if (context.tools) {
		params.tools = convertTools(context.tools, compat, model);
		if (options?.toolChoice) params.tool_choice = options.toolChoice;
		else if (compatDetection.capabilities.usesExplicitProxyLikeEndpoint && Array.isArray(params.tools) && params.tools.length > 0) params.tool_choice = "auto";
	} else if (hasToolHistory(context.messages)) params.tools = [];
	const completionsReasoningEffort = resolveOpenAICompletionsReasoningEffort(options);
	const resolvedCompletionsReasoningEffort = completionsReasoningEffort ? resolveOpenAIReasoningEffortForModel({
		model,
		effort: completionsReasoningEffort,
		fallbackMap: compat.reasoningEffortMap
	}) : void 0;
	const omitGpt54MiniToolReasoningEffort = isOpenAIGpt54MiniModel(model) && Array.isArray(params.tools) && params.tools.length > 0;
	if (compat.thinkingFormat === "openrouter" && model.reasoning && resolvedCompletionsReasoningEffort) params.reasoning = { effort: resolvedCompletionsReasoningEffort };
	else if (resolvedCompletionsReasoningEffort && model.reasoning && compat.supportsReasoningEffort && !omitGpt54MiniToolReasoningEffort) params.reasoning_effort = resolvedCompletionsReasoningEffort;
	return params;
}
function parseTransportChunkUsage(rawUsage, model) {
	const cachedTokens = rawUsage.prompt_tokens_details?.cached_tokens || 0;
	const promptTokens = rawUsage.prompt_tokens || 0;
	const input = Math.max(0, promptTokens - cachedTokens);
	const outputTokens = rawUsage.completion_tokens || 0;
	const usage = {
		input,
		output: outputTokens,
		cacheRead: cachedTokens,
		cacheWrite: 0,
		totalTokens: input + outputTokens + cachedTokens,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
	calculateCost(model, usage);
	return usage;
}
function mapStopReason(reason) {
	if (reason === null) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
		case "end": return { stopReason: "stop" };
		case "length": return { stopReason: "length" };
		case "function_call":
		case "tool_call":
		case "tool_calls": return { stopReason: "toolUse" };
		case "content_filter": return {
			stopReason: "error",
			errorMessage: "Provider finish_reason: content_filter"
		};
		case "network_error": return {
			stopReason: "error",
			errorMessage: "Provider finish_reason: network_error"
		};
		default: return {
			stopReason: "error",
			errorMessage: `Provider finish_reason: ${reason}`
		};
	}
}
//#endregion
export { resolveOpenAIReasoningEffortForModel as C, normalizeOpenAIReasoningEffort as S, transformTransportMessages as _, applyOpenAIResponsesPayloadPolicy as a, resolveOpenAIStrictToolFlagForInventory as b, coerceTransportToolCallArguments as c, failTransportStream as d, finalizeTransportStream as f, sanitizeTransportPayloadText as g, sanitizeNonEmptyTransportPayloadText as h, createOpenAIResponsesTransportStreamFn as i, createEmptyTransportUsage as l, mergeTransportMetadata as m, createAzureOpenAIResponsesTransportStreamFn as n, resolveOpenAIResponsesPayloadPolicy as o, mergeTransportHeaders as p, createOpenAICompletionsTransportStreamFn as r, flattenCompletionMessagesToStringContent as s, buildOpenAICompletionsParams as t, createWritableTransportEventStream as u, buildGuardedModelFetch as v, resolveOpenAIStrictToolSetting as w, mapOpenAIReasoningEffortForModel as x, normalizeOpenAIStrictToolParameters as y };
