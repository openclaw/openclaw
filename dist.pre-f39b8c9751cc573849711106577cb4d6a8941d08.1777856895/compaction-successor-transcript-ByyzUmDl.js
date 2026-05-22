import { i as redactSensitiveText } from "./redact-1fZUZMlV.js";
import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, f as readStringValue, n as localeLowercasePreservingWhitespace, s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { n as isAbortError } from "./unhandled-rejections-C21vjQEV.js";
import { r as openBoundaryFile } from "./boundary-file-read-7ScTVYIc.js";
import { r as normalizeProviderId } from "./provider-id-dd60CFPS.js";
import { t as createSubsystemLogger } from "./subsystem-CgTF-J8V.js";
import { n as normalizeAccountId } from "./account-id-fkYplFFW.js";
import { y as resolveAgentContextLimits } from "./agent-scope-CzfWAE9r.js";
import { t as DEFAULT_CONTEXT_TOKENS } from "./defaults-DNihGLJv.js";
import { t as parseDurationMs } from "./parse-duration-BN0AM1mL.js";
import { t as resolveAccountEntry } from "./account-lookup-BtBP9pcu.js";
import { t as rawDataToString } from "./ws-CeLg2K6k.js";
import { a as normalizeAnyChannelId } from "./registry-G5ZTYALl.js";
import { i as hasInterSessionUserProvenance, n as annotateInterSessionPromptText, o as normalizeInputProvenance, r as applyInputProvenanceToUserMessage } from "./input-provenance-DVjdbTIo.js";
import { y as getCompactionProvider } from "./loader-BPHnZ58g.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-j8teApmQ.js";
import { C as isCacheEnabled, w as resolveCacheTtlMs, x as createExpiringMapCache } from "./store-load-CPVa0fsE.js";
import { s as emitSessionTranscriptUpdate } from "./transcript-B8uR0k8y.js";
import { a as normalizeAssistantPhase, o as parseAssistantTextSignature, t as encodeAssistantTextSignature } from "./chat-message-content-Cga1Sfvg.js";
import { B as resolveProviderWebSocketSessionPolicyWithPlugin, E as resolveProviderCacheTtlEligibility, L as resolveProviderTransportTurnStateWithPlugin, U as sanitizeProviderReplayHistoryWithPlugin, q as validateProviderReplayTurnsWithPlugin } from "./provider-runtime-7IfUFCM-.js";
import { n as resolveProviderEndpoint } from "./provider-attribution-h_knWqVv.js";
import { i as getModelProviderRequestTransport, l as resolveProviderRequestPolicyConfig, r as buildProviderRequestTlsClientOptions } from "./provider-request-config-DT1B_A_J.js";
import { f as supportsAutomaticThreadBindingSpawn, u as resolveThreadBindingSpawnPolicy } from "./thread-bindings-policy-BIa01M5B.js";
import { a as makeZeroUsageSnapshot, o as normalizeUsage } from "./usage-CbNR5ctp.js";
import { S as firstEnumerableOwnKeys, w as jsonUtf8BytesOrInfinity, x as boundedJsonUtf8Bytes } from "./session-utils.fs-D59mRZNQ.js";
import { u as stripRuntimeContextCustomMessages } from "./internal-runtime-context-DPUTT2wY.js";
import { n as stripInboundMetadata } from "./strip-inbound-meta-BDl97B8O.js";
import { n as matchesAnyGlobPattern, t as compileGlobPatterns } from "./glob-pattern-CQ5fwxlS.js";
import { a as resolveContextWindowInfo } from "./context-window-guard-DBZw--sb.js";
import { a as isSilentReplyText } from "./tokens-Dao2HVOa.js";
import { c as stripHeartbeatToken } from "./heartbeat-C0n-SWz4.js";
import { c as sanitizeGoogleTurnOrdering } from "./google-CpBx9Jzo.js";
import { c as downgradeOpenAIFunctionCallReasoningPairs, l as downgradeOpenAIReasoningBlocks, n as validateGeminiTurns, s as sanitizeSessionMessagesImages, t as validateAnthropicTurns } from "./pi-embedded-helpers-BTvKbJ6F.js";
import { n as extractToolResultId, r as sanitizeToolCallIdsForCloudCodeAssist, t as extractToolCallsFromAssistant } from "./tool-call-id-DcZS3Co9.js";
import { i as resolveImageSanitizationLimits } from "./tool-images-BUo2E8V0.js";
import { s as resolveChannelPromptCapabilities } from "./channel-tools-DFFAwqNi.js";
import { a as isTimeoutError } from "./failover-error-BQkZNf2j.js";
import { n as resolveTranscriptPolicy, o as collectTextContentBlocks, r as shouldAllowProviderOwnedThinkingReplay, t as createAgentToolResultMiddlewareRunner } from "./tool-result-middleware-MXGuUxem.js";
import { S as normalizeOpenAIReasoningEffort, b as resolveOpenAIStrictToolFlagForInventory, m as mergeTransportMetadata, w as resolveOpenAIStrictToolSetting, x as mapOpenAIReasoningEffortForModel, y as normalizeOpenAIStrictToolParameters } from "./openai-transport-stream-DNMpbwLT.js";
import { n as createDebugProxyWebSocketAgent, r as resolveDebugProxySettings } from "./env-B8VzMjNy.js";
import { n as captureWsEvent } from "./runtime-DwV8HwbV.js";
import { t as log$1 } from "./logger-U0HIdILh.js";
import { y as resolveOpenAITextVerbosity } from "./proxy-stream-wrappers-BKOJCTrO.js";
import { i as stripSystemPromptCacheBoundary } from "./system-prompt-cache-boundary-PnO9xKdH.js";
import { o as buildCopilotIdeHeaders } from "./provider-auth-CK1ryEny.js";
import { n as hasCopilotVisionInput, t as buildCopilotDynamicHeaders } from "./copilot-dynamic-headers-uRCEexOZ.js";
import { a as stripToolResultDetails, i as sanitizeToolUseResultPairing, n as repairToolUseResultPairing, r as sanitizeToolCallInputs, t as makeMissingToolResult } from "./session-transcript-repair-BQ7v-CrQ.js";
import { a as createOpenClawTransportStreamFnForModel, i as createBoundaryAwareStreamFnForModel } from "./provider-stream-nDuXXEkw.js";
import { a as pruneHistoryForContextShare, h as formatContextLimitTruncationNotice, i as estimateMessagesTokens, m as truncateToolResultMessage, n as SUMMARIZATION_OVERHEAD_TOKENS, o as resolveContextWindowTokens$1, r as computeAdaptiveChunkRatio, s as summarizeInStages, u as resolveLiveToolResultMaxChars } from "./compaction-9RgCg-8V.js";
import "./pi-settings-BDCABwYO.js";
import { a as toToolDefinitions } from "./pi-tool-definition-adapter-Dw1LgS9u.js";
import { a as setRawSessionAppendMessage, c as readTranscriptFileState, i as getRawSessionAppendMessage, l as writeTranscriptFileAtomic, o as TranscriptFileState } from "./transcript-rewrite-BmypOHci.js";
import { i as resolveSkillRuntimeConfig } from "./env-overrides-BUphityl.js";
import { o as loadWorkspaceSkillEntries } from "./workspace-DpYyYGQ0.js";
import "./skills-B_Z_lSPe.js";
import { i as resolveUserTimezone } from "./date-time-Bhu15KcE.js";
import { D as isAnthropicFamilyCacheTtlEligible, O as isAnthropicModelRef } from "./provider-stream-shared-BGzoIsk9.js";
import { o as isGooglePromptCacheEligible } from "./extra-params-CSQMtQXR.js";
import { n as resolveCronStyleNow } from "./current-time-C9Ojz3ik.js";
import { n as isQueryStopWordToken, t as extractKeywords } from "./query-expansion-a_PqbAXe.js";
import "./query-Ccra__ou.js";
import { o as wrapUntrustedPromptDataBlock, t as buildAgentSystemPrompt } from "./system-prompt--xdJEfr-.js";
import { t as estimateStringChars } from "./cjk-chars-C_1Sv6M2.js";
import { t as createAnthropicVertexStreamFnForModel } from "./anthropic-vertex-stream-DAEemJ_R.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { Buffer as Buffer$1 } from "node:buffer";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import * as piAi from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
//#region src/agents/openai-ws-request.ts
function stringifyStable$1(value) {
	if (value === void 0) return "";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((entry) => stringifyStable$1(entry)).join(",")}]`;
	return `{${Object.entries(value).filter(([, entry]) => entry !== void 0).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stringifyStable$1(entry)}`).join(",")}}`;
}
function payloadWithoutIncrementalFields(payload) {
	const { input: _input, metadata: _metadata, previous_response_id: _previousResponseId, ...rest } = payload;
	return rest;
}
function payloadFieldsMatch(left, right) {
	return stringifyStable$1(payloadWithoutIncrementalFields(left)) === stringifyStable$1(payloadWithoutIncrementalFields(right));
}
function inputItemsStartWith(input, baseline) {
	if (baseline.length > input.length) return false;
	return baseline.every((item, index) => stringifyStable$1(item) === stringifyStable$1(input[index]));
}
function planOpenAIWebSocketRequestPayload(params) {
	const fullInputItems = Array.isArray(params.fullPayload.input) ? params.fullPayload.input : [];
	const previousInputItems = Array.isArray(params.previousRequestPayload?.input) ? params.previousRequestPayload.input : [];
	const previousResponseInputItems = params.previousResponseInputItems ?? [];
	if (params.previousResponseId && params.previousRequestPayload && payloadFieldsMatch(params.fullPayload, params.previousRequestPayload)) {
		const baseline = [...previousInputItems, ...previousResponseInputItems];
		if (inputItemsStartWith(fullInputItems, baseline)) return {
			mode: "incremental",
			payload: {
				...params.fullPayload,
				previous_response_id: params.previousResponseId,
				input: fullInputItems.slice(baseline.length)
			}
		};
	}
	const { previous_response_id: _previousResponseId, ...payload } = params.fullPayload;
	return {
		mode: "full_context",
		payload
	};
}
function buildOpenAIWebSocketWarmUpPayload(params) {
	return {
		type: "response.create",
		generate: false,
		model: params.model,
		input: [],
		...params.tools?.length ? { tools: params.tools } : {},
		...params.instructions ? { instructions: params.instructions } : {},
		...params.metadata ? { metadata: params.metadata } : {}
	};
}
function buildOpenAIWebSocketResponseCreatePayload(params) {
	const extraParams = {};
	const streamOpts = params.options;
	if (streamOpts?.temperature !== void 0) extraParams.temperature = streamOpts.temperature;
	if (streamOpts?.maxTokens !== void 0) extraParams.max_output_tokens = streamOpts.maxTokens;
	if (streamOpts?.topP !== void 0) extraParams.top_p = streamOpts.topP;
	if (streamOpts?.toolChoice !== void 0) extraParams.tool_choice = streamOpts.toolChoice;
	const reasoningEffort = mapOpenAIReasoningEffortForModel({
		model: params.model,
		effort: streamOpts?.reasoningEffort ?? streamOpts?.reasoning ?? (params.model.reasoning ? "high" : void 0)
	});
	if (reasoningEffort || streamOpts?.reasoningSummary) {
		const reasoning = {};
		if (reasoningEffort !== void 0) reasoning.effort = normalizeOpenAIReasoningEffort(reasoningEffort);
		if (reasoningEffort !== "none" && streamOpts?.reasoningSummary !== void 0) reasoning.summary = streamOpts.reasoningSummary;
		extraParams.reasoning = reasoning;
		if (reasoning.effort && reasoning.effort !== "none") extraParams.include = ["reasoning.encrypted_content"];
	}
	const textVerbosity = resolveOpenAITextVerbosity(streamOpts);
	if (textVerbosity !== void 0) extraParams.text = {
		...extraParams.text && typeof extraParams.text === "object" ? extraParams.text : {},
		verbosity: textVerbosity
	};
	const supportsResponsesStoreField = resolveProviderRequestPolicyConfig({
		provider: readStringValue(params.model.provider),
		api: readStringValue(params.model.api),
		baseUrl: readStringValue(params.model.baseUrl),
		compat: params.model.compat,
		capability: "llm",
		transport: "websocket"
	}).capabilities.supportsResponsesStoreField;
	return {
		type: "response.create",
		model: params.model.id,
		...supportsResponsesStoreField ? { store: false } : {},
		input: params.turnInput.inputItems,
		instructions: params.context.systemPrompt ? stripSystemPromptCacheBoundary(params.context.systemPrompt) : void 0,
		tools: params.tools.length > 0 ? params.tools : void 0,
		...params.turnInput.previousResponseId ? { previous_response_id: params.turnInput.previousResponseId } : {},
		...params.metadata ? { metadata: params.metadata } : {},
		...extraParams
	};
}
//#endregion
//#region src/agents/openai-ws-connection.ts
/**
* OpenAI WebSocket Connection Manager
*
* Manages a persistent WebSocket connection to the OpenAI Responses API
* (wss://api.openai.com/v1/responses) for multi-turn tool-call workflows.
*
* Features:
* - Auto-reconnect with exponential backoff (max 5 retries: 1s/2s/4s/8s/16s)
* - Tracks previous_response_id per connection for incremental turns
* - Warm-up support (generate: false) to pre-load the connection
* - Typed WebSocket event definitions matching the Responses API SSE spec
*
* @see https://developers.openai.com/api/docs/guides/websocket-mode
*/
const OPENAI_WS_URL = "wss://api.openai.com/v1/responses";
const MAX_RETRIES = 5;
/** Backoff delays in ms: 1s, 2s, 4s, 8s, 16s */
const BACKOFF_DELAYS_MS = [
	1e3,
	2e3,
	4e3,
	8e3,
	16e3
];
/**
* Manages a persistent WebSocket connection to the OpenAI Responses API.
*
* Usage:
* ```ts
* const manager = new OpenAIWebSocketManager();
* await manager.connect(apiKey);
*
* manager.onMessage((event) => {
*   if (event.type === "response.completed") {
*     console.log("Response ID:", event.response.id);
*   }
* });
*
* manager.send({ type: "response.create", model: "gpt-5.4", input: [...] });
* ```
*/
var OpenAIWebSocketManager = class extends EventEmitter {
	constructor(options = {}) {
		super();
		this.ws = null;
		this.apiKey = null;
		this.retryCount = 0;
		this.retryTimer = null;
		this.closed = false;
		this._previousResponseId = null;
		this._connectionState = "idle";
		this._lastCloseInfo = null;
		this.wsUrl = options.url ?? OPENAI_WS_URL;
		this.maxRetries = options.maxRetries ?? MAX_RETRIES;
		this.backoffDelaysMs = options.backoffDelaysMs ?? BACKOFF_DELAYS_MS;
		this.socketFactory = options.socketFactory ?? ((url, socketOptions) => new WebSocket(url, socketOptions));
		this.headers = options.headers;
		this.request = options.request;
		this.flowId = randomUUID();
	}
	/**
	* Returns the previous_response_id from the last completed response,
	* for use in subsequent response.create events.
	*/
	get previousResponseId() {
		return this._previousResponseId;
	}
	get connectionState() {
		return this._connectionState;
	}
	get lastCloseInfo() {
		return this._lastCloseInfo;
	}
	/**
	* Opens a WebSocket connection to the OpenAI Responses API.
	* Resolves when the connection is established (open event fires).
	* Rejects if the initial connection fails after max retries.
	*/
	connect(apiKey) {
		this.apiKey = apiKey;
		this.closed = false;
		this.retryCount = 0;
		this._connectionState = "connecting";
		this._lastCloseInfo = null;
		return this._openConnection();
	}
	/**
	* Sends a typed event to the OpenAI Responses API over the WebSocket.
	* Throws if the connection is not open.
	*/
	send(event) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error(`OpenAIWebSocketManager: cannot send — connection is not open (readyState=${this.ws?.readyState ?? "no socket"})`);
		const payload = JSON.stringify(event);
		captureWsEvent({
			url: this.wsUrl,
			direction: "outbound",
			kind: "ws-frame",
			flowId: this.flowId,
			payload,
			meta: { eventType: event.type }
		});
		this.ws.send(payload);
	}
	/**
	* Registers a handler for incoming server-sent WebSocket events.
	* Returns an unsubscribe function.
	*/
	onMessage(handler) {
		this.on("message", handler);
		return () => {
			this.off("message", handler);
		};
	}
	/**
	* Returns true if the WebSocket is currently open and ready to send.
	*/
	isConnected() {
		return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
	}
	/**
	* Permanently closes the WebSocket connection and disables auto-reconnect.
	*/
	close() {
		this.closed = true;
		this._connectionState = "closed";
		this._cancelRetryTimer();
		if (this.ws) {
			this.ws.removeAllListeners();
			try {
				if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1e3, "Client closed");
				else if (this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
			} catch {}
			this.ws = null;
		}
	}
	_openConnection() {
		return new Promise((resolve, reject) => {
			if (!this.apiKey) {
				reject(/* @__PURE__ */ new Error("OpenAIWebSocketManager: apiKey is required before connecting."));
				return;
			}
			const requestConfig = resolveProviderRequestPolicyConfig({
				provider: "openai",
				api: "openai-responses",
				baseUrl: this.wsUrl,
				capability: "llm",
				transport: "websocket",
				providerHeaders: {
					Authorization: `Bearer ${this.apiKey}`,
					"OpenAI-Beta": "responses-websocket=v1",
					...this.headers
				},
				precedence: "defaults-win",
				request: this.request,
				allowPrivateNetwork: this.request?.allowPrivateNetwork === true
			});
			const debugAgent = createDebugProxyWebSocketAgent(resolveDebugProxySettings());
			const socket = this.socketFactory(this.wsUrl, {
				headers: requestConfig.headers,
				...debugAgent ? { agent: debugAgent } : {},
				...buildProviderRequestTlsClientOptions(requestConfig)
			});
			this.ws = socket;
			const onOpen = () => {
				this.retryCount = 0;
				this._connectionState = "open";
				this._lastCloseInfo = null;
				captureWsEvent({
					url: this.wsUrl,
					direction: "local",
					kind: "ws-open",
					flowId: this.flowId
				});
				resolve();
				this.emit("open");
			};
			const onError = (err) => {
				socket.off("open", onOpen);
				if (this.listenerCount("error") > 0) this.emit("error", err);
				captureWsEvent({
					url: this.wsUrl,
					direction: "local",
					kind: "error",
					flowId: this.flowId,
					errorText: err.message
				});
				if (this._connectionState === "connecting" || this._connectionState === "reconnecting") this._connectionState = "closed";
				reject(err);
			};
			const onClose = (code, reason) => {
				const reasonStr = reason.toString();
				const closeInfo = {
					code,
					reason: reasonStr,
					retryable: isRetryableWebSocketClose(code)
				};
				this._lastCloseInfo = closeInfo;
				captureWsEvent({
					url: this.wsUrl,
					direction: "local",
					kind: "ws-close",
					flowId: this.flowId,
					closeCode: code,
					payload: reasonStr
				});
				this.emit("close", code, reasonStr);
				if (!this.closed && closeInfo.retryable) this._scheduleReconnect();
				else this._connectionState = "closed";
			};
			const onMessage = (data) => {
				captureWsEvent({
					url: this.wsUrl,
					direction: "inbound",
					kind: "ws-frame",
					flowId: this.flowId,
					payload: Buffer.from(rawDataToString(data))
				});
				this._handleMessage(data);
			};
			socket.once("open", onOpen);
			socket.on("error", onError);
			socket.on("close", onClose);
			socket.on("message", onMessage);
		});
	}
	_scheduleReconnect() {
		if (this.closed) return;
		if (this.retryCount >= this.maxRetries) {
			this._connectionState = "closed";
			this._safeEmitError(/* @__PURE__ */ new Error(`OpenAIWebSocketManager: max reconnect retries (${this.maxRetries}) exceeded.`));
			return;
		}
		const delayMs = this.backoffDelaysMs[Math.min(this.retryCount, this.backoffDelaysMs.length - 1)] ?? 1e3;
		this.retryCount++;
		this._connectionState = "reconnecting";
		this.retryTimer = setTimeout(() => {
			if (this.closed) return;
			this._openConnection().catch(() => {});
		}, delayMs);
	}
	/** Emit an error only if there are listeners; prevents Node.js from crashing
	*  with "unhandled 'error' event" when no one is listening. */
	_safeEmitError(err) {
		if (this.listenerCount("error") > 0) this.emit("error", err);
	}
	_cancelRetryTimer() {
		if (this.retryTimer !== null) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
	}
	_handleMessage(data) {
		let text;
		if (typeof data === "string") text = data;
		else if (Buffer.isBuffer(data)) text = data.toString("utf8");
		else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString("utf8");
		else text = String(data);
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			this._safeEmitError(/* @__PURE__ */ new Error(`OpenAIWebSocketManager: failed to parse message: ${text.slice(0, 200)}`));
			return;
		}
		if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
			this._safeEmitError(/* @__PURE__ */ new Error(`OpenAIWebSocketManager: unexpected message shape (no "type" field): ${text.slice(0, 200)}`));
			return;
		}
		const event = parsed;
		if (event.type === "response.completed" && event.response?.id) this._previousResponseId = event.response.id;
		this.emit("message", event);
	}
	/**
	* Sends a warm-up event to pre-load the connection and model without generating output.
	* Pass tools/instructions to prime the connection for the upcoming session.
	*/
	warmUp(params) {
		const event = buildOpenAIWebSocketWarmUpPayload(params);
		this.send(event);
	}
};
function getOpenAIWebSocketErrorDetails(event) {
	return {
		status: typeof event.status === "number" ? event.status : void 0,
		type: event.error?.type,
		code: event.error?.code ?? event.code,
		message: event.error?.message ?? event.message,
		param: event.error?.param ?? event.param
	};
}
function isRetryableWebSocketClose(code) {
	return code === 1001 || code === 1005 || code === 1006 || code === 1011 || code === 1012 || code === 1013;
}
//#endregion
//#region src/agents/stream-message-shared.ts
function buildZeroUsage() {
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
function buildUsageWithNoCost(params) {
	const input = params.input ?? 0;
	const output = params.output ?? 0;
	return {
		input,
		output,
		cacheRead: params.cacheRead ?? 0,
		cacheWrite: params.cacheWrite ?? 0,
		totalTokens: params.totalTokens ?? input + output,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
}
function buildAssistantMessage(params) {
	return {
		role: "assistant",
		content: params.content,
		stopReason: params.stopReason,
		api: params.model.api,
		provider: params.model.provider,
		model: params.model.id,
		usage: params.usage,
		timestamp: params.timestamp ?? Date.now()
	};
}
function buildAssistantMessageWithZeroUsage(params) {
	return buildAssistantMessage({
		model: params.model,
		content: params.content,
		stopReason: params.stopReason,
		usage: buildZeroUsage(),
		timestamp: params.timestamp
	});
}
const STREAM_ERROR_FALLBACK_TEXT = "[assistant turn failed before producing content]";
function buildStreamErrorAssistantMessage(params) {
	return {
		...buildAssistantMessageWithZeroUsage({
			model: params.model,
			content: [{
				type: "text",
				text: STREAM_ERROR_FALLBACK_TEXT
			}],
			stopReason: "error",
			timestamp: params.timestamp
		}),
		stopReason: "error",
		errorMessage: params.errorMessage
	};
}
//#endregion
//#region src/agents/openai-ws-message-conversion.ts
function toNonEmptyString(value) {
	if (typeof value !== "string") return null;
	const trimmed = normalizeOptionalString(value) ?? "";
	return trimmed.length > 0 ? trimmed : null;
}
function supportsImageInput(modelOverride) {
	return !Array.isArray(modelOverride?.input) || modelOverride.input.includes("image");
}
function usesOpenAICompletionsImageParts(modelOverride) {
	return modelOverride?.api === "openai-completions";
}
function toImageUrlFromBase64(params) {
	return `data:${params.mediaType ?? "image/jpeg"};base64,${params.data}`;
}
function contentToText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => Boolean(part) && typeof part === "object").filter((part) => (part.type === "text" || part.type === "input_text" || part.type === "output_text") && typeof part.text === "string").map((part) => part.text).join("");
}
function contentToOpenAIParts(content, modelOverride) {
	if (typeof content === "string") return content ? [{
		type: "input_text",
		text: content
	}] : [];
	if (!Array.isArray(content)) return [];
	const includeImages = supportsImageInput(modelOverride);
	const useImageUrl = usesOpenAICompletionsImageParts(modelOverride);
	const parts = [];
	for (const part of content) {
		if ((part.type === "text" || part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") {
			parts.push({
				type: "input_text",
				text: part.text
			});
			continue;
		}
		if (!includeImages) continue;
		if (part.type === "image" && typeof part.data === "string") {
			if (useImageUrl) {
				parts.push({
					type: "image_url",
					image_url: { url: toImageUrlFromBase64({
						mediaType: part.mimeType,
						data: part.data
					}) }
				});
				continue;
			}
			parts.push({
				type: "input_image",
				source: {
					type: "base64",
					media_type: part.mimeType ?? "image/jpeg",
					data: part.data
				}
			});
			continue;
		}
		if (part.type === "input_image" && part.source && typeof part.source === "object" && typeof part.source.type === "string") {
			const source = part.source;
			if (useImageUrl) {
				parts.push({
					type: "image_url",
					image_url: { url: source.type === "url" ? source.url : toImageUrlFromBase64({
						mediaType: source.media_type,
						data: source.data
					}) }
				});
				continue;
			}
			parts.push({
				type: "input_image",
				source
			});
		}
	}
	return parts;
}
function isReplayableReasoningType(value) {
	return typeof value === "string" && (value === "reasoning" || value.startsWith("reasoning."));
}
function toReplayableReasoningId(value) {
	const id = toNonEmptyString(value);
	return id && id.startsWith("rs_") ? id : null;
}
function toReasoningSignature(value, options) {
	if (!value || typeof value !== "object") return null;
	const record = value;
	if (!isReplayableReasoningType(record.type)) return null;
	const reasoningId = toReplayableReasoningId(record.id);
	if (options?.requireReplayableId && !reasoningId) return null;
	return {
		type: record.type,
		...reasoningId ? { id: reasoningId } : {},
		...record.content !== void 0 ? { content: record.content } : {},
		...typeof record.encrypted_content === "string" ? { encrypted_content: record.encrypted_content } : {},
		...record.summary !== void 0 ? { summary: record.summary } : {}
	};
}
function encodeThinkingSignature(signature) {
	return JSON.stringify(signature);
}
function parseReasoningItem(value) {
	const signature = toReasoningSignature(value);
	if (!signature) return null;
	return {
		type: "reasoning",
		...signature.id ? { id: signature.id } : {},
		...signature.content !== void 0 ? { content: signature.content } : {},
		...signature.encrypted_content !== void 0 ? { encrypted_content: signature.encrypted_content } : {},
		...signature.summary !== void 0 ? { summary: signature.summary } : {}
	};
}
function parseThinkingSignature(value) {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	try {
		return parseReasoningItem(JSON.parse(value));
	} catch {
		return null;
	}
}
function encodeToolCallReplayId(params) {
	return params.itemId ? `${params.callId}|${params.itemId}` : params.callId;
}
function decodeToolCallReplayId(value) {
	const raw = toNonEmptyString(value);
	if (!raw) return null;
	const [callId, itemId] = raw.split("|", 2);
	return {
		callId,
		...itemId ? { itemId } : {}
	};
}
function extractReasoningSummaryText(value) {
	if (typeof value === "string") return value.trim();
	if (!Array.isArray(value)) return "";
	return value.map((item) => {
		if (typeof item === "string") return item.trim();
		if (!item || typeof item !== "object") return "";
		return normalizeOptionalString(item.text) ?? "";
	}).filter(Boolean).join("\n").trim();
}
function extractResponseReasoningText(item) {
	if (!item || typeof item !== "object") return "";
	const record = item;
	const summaryText = extractReasoningSummaryText(record.summary);
	if (summaryText) return summaryText;
	if (typeof record.content === "string") return normalizeOptionalString(record.content) ?? "";
	if (Array.isArray(record.content)) return record.content.map((part) => {
		if (typeof part === "string") return part.trim();
		if (!part || typeof part !== "object") return "";
		return normalizeOptionalString(part.text) ?? "";
	}).filter(Boolean).join("\n").trim();
	return "";
}
function convertTools(tools, options) {
	if (!tools || tools.length === 0) return [];
	const strict = resolveOpenAIStrictToolFlagForInventory(tools, options?.strict);
	return tools.map((tool) => {
		return {
			type: "function",
			name: tool.name,
			description: typeof tool.description === "string" ? tool.description : void 0,
			parameters: normalizeOpenAIStrictToolParameters(tool.parameters ?? {}, strict === true),
			...strict === void 0 ? {} : { strict }
		};
	});
}
function convertMessagesToInputItems(messages, modelOverride) {
	const items = [];
	for (const msg of messages) {
		const m = msg;
		if (m.role === "user") {
			const parts = contentToOpenAIParts(m.content, modelOverride);
			if (parts.length === 0) continue;
			items.push({
				type: "message",
				role: "user",
				content: parts.length === 1 && parts[0]?.type === "input_text" ? parts[0].text : parts
			});
			continue;
		}
		if (m.role === "assistant") {
			const content = m.content;
			const assistantMessagePhase = normalizeAssistantPhase(m.phase);
			if (Array.isArray(content)) {
				const textParts = [];
				let currentTextPhase;
				const hasExplicitBlockPhase = content.some((block) => {
					if (!block || typeof block !== "object") return false;
					const record = block;
					return record.type === "text" && Boolean(parseAssistantTextSignature(record.textSignature)?.phase);
				});
				const pushAssistantText = (phase) => {
					if (textParts.length === 0) return;
					items.push({
						type: "message",
						role: "assistant",
						content: textParts.join(""),
						...phase ? { phase } : {}
					});
					textParts.length = 0;
				};
				for (const block of content) {
					if (block.type === "text" && typeof block.text === "string") {
						const parsedSignature = parseAssistantTextSignature(block.textSignature);
						const blockPhase = parsedSignature?.phase ?? (parsedSignature?.id ? assistantMessagePhase : hasExplicitBlockPhase ? void 0 : assistantMessagePhase);
						if (textParts.length > 0 && blockPhase !== currentTextPhase) pushAssistantText(currentTextPhase);
						textParts.push(block.text);
						currentTextPhase = blockPhase;
						continue;
					}
					if (block.type === "thinking") {
						pushAssistantText(currentTextPhase);
						const reasoningItem = parseThinkingSignature(block.thinkingSignature);
						if (reasoningItem) items.push(reasoningItem);
						continue;
					}
					if (block.type !== "toolCall") continue;
					pushAssistantText(currentTextPhase);
					const replayId = decodeToolCallReplayId(block.id);
					const toolName = toNonEmptyString(block.name);
					if (!replayId || !toolName) continue;
					items.push({
						type: "function_call",
						...replayId.itemId ? { id: replayId.itemId } : {},
						call_id: replayId.callId,
						name: toolName,
						arguments: typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {})
					});
				}
				pushAssistantText(currentTextPhase);
				continue;
			}
			const text = contentToText(content);
			if (!text) continue;
			items.push({
				type: "message",
				role: "assistant",
				content: text,
				...assistantMessagePhase ? { phase: assistantMessagePhase } : {}
			});
			continue;
		}
		if (m.role !== "toolResult") continue;
		const toolCallId = toNonEmptyString(m.toolCallId) ?? toNonEmptyString(m.toolUseId);
		if (!toolCallId) continue;
		const replayId = decodeToolCallReplayId(toolCallId);
		if (!replayId) continue;
		const parts = Array.isArray(m.content) ? contentToOpenAIParts(m.content, modelOverride) : [];
		const textOutput = contentToText(m.content);
		const imageParts = parts.filter((part) => part.type === "input_image" || part.type === "image_url");
		items.push({
			type: "function_call_output",
			call_id: replayId.callId,
			output: textOutput || (imageParts.length > 0 ? "(see attached image)" : "")
		});
		if (imageParts.length > 0) items.push({
			type: "message",
			role: "user",
			content: [{
				type: "input_text",
				text: "Attached image(s) from tool result:"
			}, ...imageParts]
		});
	}
	return items;
}
function buildAssistantMessageFromResponse(response, modelInfo) {
	const content = [];
	const assistantMessageOutputs = (response.output ?? []).filter((item) => item.type === "message");
	const hasExplicitPhasedAssistantText = assistantMessageOutputs.some((item) => {
		const itemPhase = normalizeAssistantPhase(item.phase);
		return Boolean(itemPhase && item.content?.some((part) => part.type === "output_text" && Boolean(part.text)));
	});
	const hasFinalAnswerText = assistantMessageOutputs.some((item) => {
		if (normalizeAssistantPhase(item.phase) !== "final_answer") return false;
		return item.content?.some((part) => part.type === "output_text" && Boolean(part.text)) ?? false;
	});
	const includedAssistantPhases = /* @__PURE__ */ new Set();
	let hasIncludedUnphasedAssistantText = false;
	for (const item of response.output ?? []) if (item.type === "message") {
		const itemPhase = normalizeAssistantPhase(item.phase);
		for (const part of item.content ?? []) if (part.type === "output_text" && part.text) {
			if (!(hasFinalAnswerText ? itemPhase === "final_answer" : hasExplicitPhasedAssistantText ? itemPhase === void 0 : true)) continue;
			if (itemPhase) includedAssistantPhases.add(itemPhase);
			else hasIncludedUnphasedAssistantText = true;
			content.push({
				type: "text",
				text: part.text,
				textSignature: encodeAssistantTextSignature({
					id: item.id,
					...itemPhase ? { phase: itemPhase } : {}
				})
			});
		}
	} else if (item.type === "function_call") {
		const toolName = toNonEmptyString(item.name);
		if (!toolName) continue;
		const callId = toNonEmptyString(item.call_id);
		const itemId = toNonEmptyString(item.id);
		content.push({
			type: "toolCall",
			id: encodeToolCallReplayId({
				callId: callId ?? `call_${randomUUID()}`,
				itemId: itemId ?? void 0
			}),
			name: toolName,
			arguments: (() => {
				try {
					return JSON.parse(item.arguments);
				} catch {
					return item.arguments;
				}
			})()
		});
	} else {
		if (!isReplayableReasoningType(item.type)) continue;
		const reasoningSignature = toReasoningSignature(item, { requireReplayableId: true });
		const reasoning = extractResponseReasoningText(item);
		if (!reasoning && !reasoningSignature) continue;
		content.push({
			type: "thinking",
			thinking: reasoning,
			...reasoningSignature ? { thinkingSignature: encodeThinkingSignature(reasoningSignature) } : {}
		});
	}
	const stopReason = content.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
	const normalizedUsage = normalizeUsage(response.usage);
	const rawTotalTokens = normalizedUsage?.total;
	const resolvedTotalTokens = rawTotalTokens && rawTotalTokens > 0 ? rawTotalTokens : (normalizedUsage?.input ?? 0) + (normalizedUsage?.output ?? 0) + (normalizedUsage?.cacheRead ?? 0) + (normalizedUsage?.cacheWrite ?? 0);
	const message = buildAssistantMessage({
		model: modelInfo,
		content,
		stopReason,
		usage: buildUsageWithNoCost({
			input: normalizedUsage?.input ?? 0,
			output: normalizedUsage?.output ?? 0,
			cacheRead: normalizedUsage?.cacheRead ?? 0,
			cacheWrite: normalizedUsage?.cacheWrite ?? 0,
			totalTokens: resolvedTotalTokens > 0 ? resolvedTotalTokens : void 0
		})
	});
	const finalAssistantPhase = includedAssistantPhases.size === 1 && !hasIncludedUnphasedAssistantText ? [...includedAssistantPhases][0] : void 0;
	return finalAssistantPhase ? {
		...message,
		phase: finalAssistantPhase
	} : message;
}
function convertResponseToInputItems(response, modelInfo) {
	return convertMessagesToInputItems([buildAssistantMessageFromResponse(response, modelInfo)], modelInfo);
}
//#endregion
//#region src/agents/openai-ws-stream.ts
/**
* OpenAI WebSocket StreamFn Integration
*
* Wraps `OpenAIWebSocketManager` in a `StreamFn` that can be plugged into the
* pi-embedded-runner agent in place of the default `streamSimple` HTTP function.
*
* Key behaviours:
*  - Per-session `OpenAIWebSocketManager` (keyed by sessionId)
*  - Tracks `previous_response_id` to send only incremental tool-result inputs
*  - Falls back to the OpenClaw HTTP transport if the WebSocket connection fails
*  - Cleanup helpers for releasing sessions after the run completes
*
* Complexity budget & risk mitigation:
*  - **Transport aware**: respects `transport` (`auto` | `websocket` | `sse`)
*  - **Transparent fallback in `auto` mode**: connect/send failures fall back to
*    the existing HTTP path; forced `websocket` mode surfaces WS errors
*  - **Zero shared state**: per-session registry; session cleanup on dispose prevents leaks
*  - **Full parity**: all generation options (temperature, top_p, max_output_tokens,
*    tool_choice, reasoning) forwarded identically to the HTTP path
*
* @see src/agents/openai-ws-connection.ts for the connection manager
*/
function resolveOpenAIWebSocketStrictToolSetting(model) {
	return resolveOpenAIStrictToolSetting(model, {
		transport: "websocket",
		supportsStrictMode: model.compat && typeof model.compat === "object" ? model.compat.supportsStrictMode : void 0
	});
}
/** Module-level registry: sessionId → WsSession */
const wsRegistry = /* @__PURE__ */ new Map();
let openAIWsStreamDeps = {
	createManager: (options) => new OpenAIWebSocketManager(options),
	createHttpFallbackStreamFn: (model) => createOpenClawTransportStreamFnForModel(model),
	streamSimple: (...args) => piAi.streamSimple(...args)
};
var LocalAssistantMessageEventStream = class {
	constructor() {
		this.queue = [];
		this.waiting = [];
		this.done = false;
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}
	push(event) {
		if (this.done) return;
		if (event.type === "done") {
			this.done = true;
			this.resolveFinalResult(event.message);
		} else if (event.type === "error") {
			this.done = true;
			this.resolveFinalResult(event.error);
		}
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter({
				value: event,
				done: false
			});
			return;
		}
		this.queue.push(event);
	}
	end(result) {
		this.done = true;
		if (result) this.resolveFinalResult(result);
		while (this.waiting.length > 0) this.waiting.shift()?.({
			value: void 0,
			done: true
		});
	}
	async *[Symbol.asyncIterator]() {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift();
				continue;
			}
			if (this.done) return;
			const result = await new Promise((resolve) => {
				this.waiting.push(resolve);
			});
			if (result.done) return;
			yield result.value;
		}
	}
	result() {
		return this.finalResultPromise;
	}
};
function createEventStream() {
	return typeof piAi.createAssistantMessageEventStream === "function" ? piAi.createAssistantMessageEventStream() : new LocalAssistantMessageEventStream();
}
function resolveWsSessionPoolConfig(env = process.env) {
	const enabled = env.OPENCLAW_OPENAI_WS_POOL === "1" || env.OPENCLAW_OPENAI_WS_SESSION_POOL === "1";
	const rawIdleMs = Number(env.OPENCLAW_OPENAI_WS_SESSION_POOL_IDLE_MS);
	return {
		enabled,
		idleMs: Number.isFinite(rawIdleMs) ? Math.min(3e5, Math.max(1e3, Math.trunc(rawIdleMs))) : 3e4
	};
}
function clearWsSessionIdleTimer(session) {
	if (!session.idleTimer) return;
	clearTimeout(session.idleTimer);
	session.idleTimer = void 0;
	session.pooledUntil = void 0;
}
function closeWsSession(sessionId, session) {
	clearWsSessionIdleTimer(session);
	try {
		session.manager.close();
	} catch {}
	wsRegistry.delete(sessionId);
}
/**
* Release and close the WebSocket session for the given sessionId.
* Call this after the agent run completes to free the connection.
*/
function releaseWsSession(sessionId, options = {}) {
	const session = wsRegistry.get(sessionId);
	if (!session) return;
	const pool = resolveWsSessionPoolConfig(options.env);
	if (options.allowPool === true && pool.enabled && !session.broken && session.manager.isConnected()) {
		clearWsSessionIdleTimer(session);
		session.pooledUntil = Date.now() + pool.idleMs;
		session.idleTimer = setTimeout(() => {
			if (wsRegistry.get(sessionId) === session) closeWsSession(sessionId, session);
		}, pool.idleMs);
		session.idleTimer.unref?.();
		log$1.debug(`[ws-stream] pooled websocket session=${sessionId} idleMs=${pool.idleMs}`);
		return;
	}
	closeWsSession(sessionId, session);
}
const WARM_UP_TIMEOUT_MS = 8e3;
const MAX_AUTO_WS_RUNTIME_RETRIES = 1;
const DEFAULT_WS_DEGRADE_COOLDOWN_MS = 6e4;
let wsDegradeCooldownMsOverride;
var OpenAIWebSocketRuntimeError = class extends Error {
	constructor(message, params) {
		super(message);
		this.name = "OpenAIWebSocketRuntimeError";
		this.kind = params.kind;
		this.retryable = params.retryable;
		this.closeCode = params.closeCode;
		this.closeReason = params.closeReason;
	}
};
function resolveWsTransport(options) {
	const transport = options?.transport;
	return transport === "sse" || transport === "websocket" || transport === "auto" ? transport : "auto";
}
function resolveWsWarmup(options) {
	return options?.openaiWsWarmup === true;
}
function resetWsSession(params) {
	clearWsSessionIdleTimer(params.session);
	try {
		params.session.manager.close();
	} catch {}
	params.session.manager = params.createManager();
	params.session.everConnected = false;
	params.session.warmUpAttempted = false;
	params.session.broken = false;
	params.session.lastContextLength = 0;
	params.session.lastRequestPayload = void 0;
	params.session.lastResponseInputItems = [];
	if (!params.preserveDegradeUntil) params.session.degradedUntil = null;
}
function markWsSessionDegraded(session) {
	session.degradedUntil = Date.now() + session.degradeCooldownMs;
}
function isWsSessionDegraded(session) {
	if (!session.degradedUntil) return false;
	if (session.degradedUntil <= Date.now()) {
		session.degradedUntil = null;
		return false;
	}
	return true;
}
function createWsManager(managerOptions, sessionHeaders) {
	return openAIWsStreamDeps.createManager({
		...managerOptions,
		...sessionHeaders ? { headers: {
			...managerOptions?.headers,
			...sessionHeaders
		} } : {}
	});
}
function stringifyStable(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((entry) => stringifyStable(entry)).join(",")}]`;
	return `{${Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stringifyStable(entry)}`).join(",")}}`;
}
function resolveWsManagerConfigSignature(managerOptions, sessionHeaders) {
	return stringifyStable({
		headers: sessionHeaders,
		request: managerOptions?.request,
		url: managerOptions?.url
	});
}
function resolveWsAuthSignature(apiKey) {
	return createHash("sha256").update(apiKey).digest("hex");
}
const AZURE_OPENAI_PROVIDER_IDS = new Set(["azure-openai", "azure-openai-responses"]);
const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
function normalizeTransportIdentityValue(value, maxLength = 160) {
	const trimmed = value.trim().replace(/[\r\n]+/gu, " ");
	return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}
function usesNativeOpenAIRoute(provider, baseUrl) {
	const endpointClass = resolveProviderEndpoint(baseUrl).endpointClass;
	const normalizedProvider = normalizeProviderId(provider);
	if (!normalizedProvider) return false;
	if (normalizedProvider === "openai") return endpointClass === "default" || endpointClass === "openai-public";
	if (AZURE_OPENAI_PROVIDER_IDS.has(normalizedProvider)) return endpointClass === "default" || endpointClass === "azure-openai";
	if (normalizedProvider === OPENAI_CODEX_PROVIDER_ID) return endpointClass === "default" || endpointClass === "openai-public" || endpointClass === "openai-codex";
	return false;
}
function resolveNativeOpenAISessionHeaders(params) {
	if (!params.sessionId || !usesNativeOpenAIRoute(params.provider, params.baseUrl)) return;
	const sessionId = normalizeTransportIdentityValue(params.sessionId);
	if (!sessionId) return;
	return {
		"x-client-request-id": sessionId,
		"x-openclaw-session-id": sessionId
	};
}
function resolveNativeOpenAITransportTurnState(params) {
	const sessionHeaders = resolveNativeOpenAISessionHeaders({
		provider: params.provider,
		baseUrl: params.baseUrl,
		sessionId: params.sessionId
	});
	if (!sessionHeaders) return;
	const turnId = normalizeTransportIdentityValue(params.turnId);
	const attempt = String(Math.max(1, params.attempt));
	return {
		headers: {
			...sessionHeaders,
			"x-openclaw-turn-id": turnId,
			"x-openclaw-turn-attempt": attempt
		},
		metadata: {
			openclaw_session_id: sessionHeaders["x-openclaw-session-id"] ?? "",
			openclaw_turn_id: turnId,
			openclaw_turn_attempt: attempt,
			openclaw_transport: params.transport
		}
	};
}
function resolveProviderTransportTurnState(model, params) {
	if (usesNativeOpenAIRoute(model.provider, model.baseUrl)) return resolveNativeOpenAITransportTurnState({
		provider: model.provider,
		baseUrl: model.baseUrl,
		sessionId: params.sessionId,
		turnId: params.turnId,
		attempt: params.attempt,
		transport: params.transport
	});
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
	}) ?? void 0;
}
function resolveWebSocketSessionPolicy(model, sessionId) {
	if (usesNativeOpenAIRoute(model.provider, model.baseUrl)) return {
		headers: resolveNativeOpenAISessionHeaders({
			provider: model.provider,
			baseUrl: model.baseUrl,
			sessionId
		}),
		degradeCooldownMs: Math.max(0, wsDegradeCooldownMsOverride ?? DEFAULT_WS_DEGRADE_COOLDOWN_MS)
	};
	const policy = resolveProviderWebSocketSessionPolicyWithPlugin({
		provider: model.provider,
		context: {
			provider: model.provider,
			modelId: model.id,
			model,
			sessionId
		}
	});
	return {
		headers: policy?.headers,
		degradeCooldownMs: Math.max(0, wsDegradeCooldownMsOverride ?? policy?.degradeCooldownMs ?? DEFAULT_WS_DEGRADE_COOLDOWN_MS)
	};
}
function formatOpenAIWebSocketError(event) {
	const details = getOpenAIWebSocketErrorDetails(event);
	const code = details.code ?? "unknown";
	const message = details.message ?? "Unknown error";
	const extras = [
		typeof details.status === "number" ? `status=${details.status}` : null,
		details.type ? `type=${details.type}` : null,
		details.param ? `param=${details.param}` : null
	].filter(Boolean);
	return extras.length > 0 ? `${message} (code=${code}; ${extras.join(", ")})` : `${message} (code=${code})`;
}
function formatOpenAIWebSocketResponseFailure(response) {
	if (response.error) return `${response.error.code || "unknown"}: ${response.error.message || "no message"}`;
	if (response.incomplete_details?.reason) return `incomplete: ${response.incomplete_details.reason}`;
	return "Unknown error (no error details in response)";
}
function normalizeWsRunError(err) {
	if (err instanceof OpenAIWebSocketRuntimeError) return err;
	return new OpenAIWebSocketRuntimeError(formatErrorMessage(err), {
		kind: "server",
		retryable: false
	});
}
function buildRetryableSendError(err) {
	return new OpenAIWebSocketRuntimeError(err instanceof Error ? err.message : `WebSocket send failed: ${String(err)}`, {
		kind: "send",
		retryable: true
	});
}
async function runWarmUp(params) {
	if (params.signal?.aborted) throw new Error("aborted");
	await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(/* @__PURE__ */ new Error(`warm-up timed out after ${WARM_UP_TIMEOUT_MS}ms`));
		}, WARM_UP_TIMEOUT_MS);
		const abortHandler = () => {
			cleanup();
			reject(/* @__PURE__ */ new Error("aborted"));
		};
		const closeHandler = (code, reason) => {
			cleanup();
			reject(/* @__PURE__ */ new Error(`warm-up closed (code=${code}, reason=${reason || "unknown"})`));
		};
		const unsubscribe = params.manager.onMessage((event) => {
			if (event.type === "response.completed") {
				cleanup();
				resolve();
			} else if (event.type === "response.failed") {
				cleanup();
				reject(/* @__PURE__ */ new Error(`warm-up failed: ${formatOpenAIWebSocketResponseFailure(event.response)}`));
			} else if (event.type === "error") {
				cleanup();
				reject(/* @__PURE__ */ new Error(`warm-up error: ${formatOpenAIWebSocketError(event)}`));
			}
		});
		const cleanup = () => {
			clearTimeout(timeout);
			params.signal?.removeEventListener("abort", abortHandler);
			params.manager.off("close", closeHandler);
			unsubscribe();
		};
		params.signal?.addEventListener("abort", abortHandler, { once: true });
		params.manager.on("close", closeHandler);
		params.manager.warmUp({
			model: params.modelId,
			tools: params.tools.length > 0 ? params.tools : void 0,
			instructions: params.instructions,
			...params.metadata ? { metadata: params.metadata } : {}
		});
	});
}
/**
* Creates a `StreamFn` backed by a persistent WebSocket connection to the
* OpenAI Responses API.  The first call for a given `sessionId` opens the
* connection; subsequent calls reuse it, sending only incremental tool-result
* inputs with `previous_response_id`.
*
* If the WebSocket connection is unavailable, the function falls back to an
* OpenClaw HTTP transport when available, or the standard `streamSimple` path.
*
* @param apiKey     OpenAI API key
* @param sessionId  Agent session ID (used as the registry key)
* @param opts       Optional manager + abort signal overrides
*/
function createOpenAIWebSocketStreamFn(apiKey, sessionId, opts = {}) {
	return (model, context, options) => {
		const eventStream = createEventStream();
		const run = async () => {
			const transport = resolveWsTransport(options);
			if (transport === "sse") return fallbackToHttp(model, context, options, apiKey, eventStream, opts.signal);
			const signal = opts.signal ?? options?.signal;
			let emittedStart = false;
			let runtimeRetries = 0;
			const turnId = randomUUID();
			let turnAttempt = 0;
			const wsSessionPolicy = resolveWebSocketSessionPolicy(model, sessionId);
			const sessionHeaders = wsSessionPolicy.headers;
			while (true) {
				let session = wsRegistry.get(sessionId);
				const authSignature = resolveWsAuthSignature(apiKey);
				const managerConfigSignature = resolveWsManagerConfigSignature(opts.managerOptions, sessionHeaders);
				if (!session) {
					session = {
						manager: createWsManager(opts.managerOptions, sessionHeaders),
						managerConfigSignature,
						authSignature,
						lastContextLength: 0,
						lastResponseInputItems: [],
						everConnected: false,
						warmUpAttempted: false,
						broken: false,
						degradedUntil: null,
						degradeCooldownMs: wsSessionPolicy.degradeCooldownMs
					};
					wsRegistry.set(sessionId, session);
				} else if (session.managerConfigSignature !== managerConfigSignature || session.authSignature !== authSignature) {
					clearWsSessionIdleTimer(session);
					resetWsSession({
						session,
						createManager: () => createWsManager(opts.managerOptions, sessionHeaders)
					});
					session.managerConfigSignature = managerConfigSignature;
					session.authSignature = authSignature;
					session.degradeCooldownMs = wsSessionPolicy.degradeCooldownMs;
				} else clearWsSessionIdleTimer(session);
				if (transport !== "websocket" && isWsSessionDegraded(session)) {
					log$1.debug(`[ws-stream] session=${sessionId} in websocket cool-down; using HTTP fallback until ${new Date(session.degradedUntil).toISOString()}`);
					return fallbackToHttp(model, context, options, apiKey, eventStream, opts.signal, {
						suppressStart: emittedStart,
						turnState: resolveProviderTransportTurnState(model, {
							sessionId,
							turnId,
							attempt: Math.max(1, turnAttempt),
							transport: "stream"
						})
					});
				}
				if (!session.manager.isConnected() && !session.broken) try {
					await session.manager.connect(apiKey);
					session.everConnected = true;
					session.degradedUntil = null;
					log$1.debug(`[ws-stream] connected for session=${sessionId}`);
				} catch (connErr) {
					markWsSessionDegraded(session);
					resetWsSession({
						session,
						createManager: () => createWsManager(opts.managerOptions, sessionHeaders),
						preserveDegradeUntil: true
					});
					if (transport === "websocket") throw connErr instanceof Error ? connErr : new Error(String(connErr));
					log$1.warn(`[ws-stream] WebSocket connect failed for session=${sessionId}; falling back to HTTP. error=${String(connErr)}`);
					return fallbackToHttp(model, context, options, apiKey, eventStream, opts.signal, {
						suppressStart: emittedStart,
						turnState: resolveProviderTransportTurnState(model, {
							sessionId,
							turnId,
							attempt: Math.max(1, turnAttempt),
							transport: "stream"
						})
					});
				}
				if (session.broken || !session.manager.isConnected()) {
					if (transport === "websocket") throw new Error("WebSocket session disconnected");
					log$1.warn(`[ws-stream] session=${sessionId} broken/disconnected; falling back to HTTP`);
					markWsSessionDegraded(session);
					resetWsSession({
						session,
						createManager: () => createWsManager(opts.managerOptions, sessionHeaders),
						preserveDegradeUntil: true
					});
					return fallbackToHttp(model, context, options, apiKey, eventStream, opts.signal, {
						suppressStart: emittedStart,
						turnState: resolveProviderTransportTurnState(model, {
							sessionId,
							turnId,
							attempt: Math.max(1, turnAttempt),
							transport: "stream"
						})
					});
				}
				if (resolveWsWarmup(options) && !session.warmUpAttempted) {
					session.warmUpAttempted = true;
					let warmupFailed = false;
					try {
						await runWarmUp({
							manager: session.manager,
							modelId: model.id,
							tools: convertTools(context.tools, { strict: resolveOpenAIWebSocketStrictToolSetting(model) }),
							instructions: context.systemPrompt ? stripSystemPromptCacheBoundary(context.systemPrompt) : void 0,
							metadata: resolveProviderTransportTurnState(model, {
								sessionId,
								turnId,
								attempt: Math.max(1, turnAttempt),
								transport: "websocket"
							})?.metadata,
							signal
						});
						log$1.debug(`[ws-stream] warm-up completed for session=${sessionId}`);
					} catch (warmErr) {
						if (signal?.aborted) throw warmErr instanceof Error ? warmErr : new Error(String(warmErr));
						warmupFailed = true;
						log$1.warn(`[ws-stream] warm-up failed for session=${sessionId}; continuing without warm-up. error=${String(warmErr)}`);
					}
					if (warmupFailed && !session.manager.isConnected()) {
						try {
							session.manager.close();
						} catch {}
						try {
							session.manager = createWsManager(opts.managerOptions, sessionHeaders);
							await session.manager.connect(apiKey);
							session.everConnected = true;
							session.degradedUntil = null;
							log$1.debug(`[ws-stream] reconnected after warm-up failure for session=${sessionId}`);
						} catch (reconnectErr) {
							markWsSessionDegraded(session);
							resetWsSession({
								session,
								createManager: () => createWsManager(opts.managerOptions, sessionHeaders),
								preserveDegradeUntil: true
							});
							if (transport === "websocket") throw reconnectErr instanceof Error ? reconnectErr : new Error(String(reconnectErr));
							log$1.warn(`[ws-stream] reconnect after warm-up failed for session=${sessionId}; falling back to HTTP. error=${String(reconnectErr)}`);
							return fallbackToHttp(model, context, options, apiKey, eventStream, opts.signal, {
								suppressStart: emittedStart,
								turnState: resolveProviderTransportTurnState(model, {
									sessionId,
									turnId,
									attempt: Math.max(1, turnAttempt),
									transport: "stream"
								})
							});
						}
					}
				}
				turnAttempt++;
				const turnState = resolveProviderTransportTurnState(model, {
					sessionId,
					turnId,
					attempt: turnAttempt,
					transport: "websocket"
				});
				let fullPayload = buildOpenAIWebSocketResponseCreatePayload({
					model,
					context,
					options,
					turnInput: { inputItems: convertMessagesToInputItems(context.messages, model) },
					tools: convertTools(context.tools, { strict: resolveOpenAIWebSocketStrictToolSetting(model) }),
					metadata: turnState?.metadata
				});
				fullPayload = mergeTransportMetadata(await options?.onPayload?.(fullPayload, model) ?? fullPayload, turnState?.metadata);
				const plannedPayload = planOpenAIWebSocketRequestPayload({
					fullPayload,
					previousRequestPayload: session.lastRequestPayload,
					previousResponseId: session.manager.previousResponseId,
					previousResponseInputItems: session.lastResponseInputItems
				});
				const plannedInputItems = Array.isArray(plannedPayload.payload.input) ? plannedPayload.payload.input : [];
				if (plannedPayload.mode === "incremental") log$1.debug(`[ws-stream] session=${sessionId}: incremental send (${plannedInputItems.length} items) previous_response_id=${plannedPayload.payload.previous_response_id}`);
				else log$1.debug(`[ws-stream] session=${sessionId}: full context send (${plannedInputItems.length} items)`);
				const requestPayload = plannedPayload.payload;
				try {
					session.manager.send(requestPayload);
				} catch (sendErr) {
					const normalizedErr = buildRetryableSendError(sendErr);
					if (transport !== "websocket" && !signal?.aborted && runtimeRetries < MAX_AUTO_WS_RUNTIME_RETRIES) {
						runtimeRetries++;
						log$1.warn(`[ws-stream] retrying websocket turn after send failure for session=${sessionId} (${runtimeRetries}/${MAX_AUTO_WS_RUNTIME_RETRIES}). error=${normalizedErr.message}`);
						resetWsSession({
							session,
							createManager: () => createWsManager(opts.managerOptions, sessionHeaders)
						});
						continue;
					}
					if (transport !== "websocket") {
						log$1.warn(`[ws-stream] send failed for session=${sessionId}; falling back to HTTP. error=${normalizedErr.message}`);
						markWsSessionDegraded(session);
						resetWsSession({
							session,
							createManager: () => createWsManager(opts.managerOptions, sessionHeaders),
							preserveDegradeUntil: true
						});
						return fallbackToHttp(model, context, options, apiKey, eventStream, opts.signal, {
							suppressStart: emittedStart,
							turnState: resolveProviderTransportTurnState(model, {
								sessionId,
								turnId,
								attempt: turnAttempt,
								transport: "stream"
							})
						});
					}
					throw normalizedErr;
				}
				if (!emittedStart) {
					eventStream.push({
						type: "start",
						partial: buildAssistantMessageWithZeroUsage({
							model,
							content: [],
							stopReason: "stop"
						})
					});
					emittedStart = true;
				}
				const outputItemPhaseById = /* @__PURE__ */ new Map();
				const outputTextByPart = /* @__PURE__ */ new Map();
				const emittedTextByPart = /* @__PURE__ */ new Map();
				const getOutputTextKey = (itemId, contentIndex) => `${itemId}:${contentIndex}`;
				const emitTextDelta = (params) => {
					const resolvedItemId = params.itemId;
					const contentIndex = params.contentIndex ?? 0;
					const itemPhase = resolvedItemId ? normalizeAssistantPhase(outputItemPhaseById.get(resolvedItemId)) : void 0;
					const partialBase = buildAssistantMessageWithZeroUsage({
						model,
						content: [{
							type: "text",
							text: params.fullText,
							...resolvedItemId ? { textSignature: encodeAssistantTextSignature({
								id: resolvedItemId,
								...itemPhase ? { phase: itemPhase } : {}
							}) } : {}
						}],
						stopReason: "stop"
					});
					const partialMsg = itemPhase ? {
						...partialBase,
						phase: itemPhase
					} : partialBase;
					eventStream.push({
						type: "text_delta",
						contentIndex,
						delta: params.deltaText,
						partial: partialMsg
					});
				};
				const emitBufferedTextDelta = (params) => {
					const key = getOutputTextKey(params.itemId, params.contentIndex);
					const fullText = outputTextByPart.get(key) ?? "";
					const emittedText = emittedTextByPart.get(key) ?? "";
					if (!fullText || fullText === emittedText) return;
					const deltaText = fullText.startsWith(emittedText) ? fullText.slice(emittedText.length) : fullText;
					emittedTextByPart.set(key, fullText);
					emitTextDelta({
						fullText,
						deltaText,
						itemId: params.itemId,
						contentIndex: params.contentIndex
					});
				};
				const capturedContextLength = context.messages.length;
				let sawWsOutput = false;
				try {
					await new Promise((resolve, reject) => {
						const abortHandler = () => {
							outputItemPhaseById.clear();
							outputTextByPart.clear();
							emittedTextByPart.clear();
							cleanup();
							reject(/* @__PURE__ */ new Error("aborted"));
						};
						if (signal?.aborted) {
							reject(/* @__PURE__ */ new Error("aborted"));
							return;
						}
						signal?.addEventListener("abort", abortHandler, { once: true });
						const closeHandler = (code, reason) => {
							outputItemPhaseById.clear();
							outputTextByPart.clear();
							emittedTextByPart.clear();
							cleanup();
							const closeInfo = session.manager.lastCloseInfo;
							reject(new OpenAIWebSocketRuntimeError(`WebSocket closed mid-request (code=${code}, reason=${reason || "unknown"})`, {
								kind: "disconnect",
								retryable: closeInfo?.retryable ?? true,
								closeCode: closeInfo?.code ?? code,
								closeReason: closeInfo?.reason ?? reason
							}));
						};
						session.manager.on("close", closeHandler);
						const cleanup = () => {
							signal?.removeEventListener("abort", abortHandler);
							session.manager.off("close", closeHandler);
							unsubscribe();
						};
						const unsubscribe = session.manager.onMessage((event) => {
							if (event.type === "response.output_item.added" || event.type === "response.output_item.done" || event.type === "response.content_part.added" || event.type === "response.content_part.done" || event.type === "response.output_text.delta" || event.type === "response.output_text.done" || event.type === "response.function_call_arguments.delta" || event.type === "response.function_call_arguments.done") sawWsOutput = true;
							if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
								if (typeof event.item.id === "string") {
									const itemPhase = event.item.type === "message" ? normalizeAssistantPhase(event.item.phase) : void 0;
									outputItemPhaseById.set(event.item.id, itemPhase);
									if (itemPhase !== void 0) {
										for (const key of outputTextByPart.keys()) if (key.startsWith(`${event.item.id}:`)) {
											const [, contentIndexText] = key.split(":");
											emitBufferedTextDelta({
												itemId: event.item.id,
												contentIndex: Number.parseInt(contentIndexText ?? "0", 10) || 0
											});
										}
									}
								}
								return;
							}
							if (event.type === "response.output_text.delta") {
								const key = getOutputTextKey(event.item_id, event.content_index);
								const nextText = `${outputTextByPart.get(key) ?? ""}${event.delta}`;
								outputTextByPart.set(key, nextText);
								if (outputItemPhaseById.get(event.item_id) !== void 0) emitBufferedTextDelta({
									itemId: event.item_id,
									contentIndex: event.content_index
								});
								return;
							}
							if (event.type === "response.output_text.done") {
								const key = getOutputTextKey(event.item_id, event.content_index);
								if (event.text && event.text !== outputTextByPart.get(key)) outputTextByPart.set(key, event.text);
								if (outputItemPhaseById.get(event.item_id) !== void 0) emitBufferedTextDelta({
									itemId: event.item_id,
									contentIndex: event.content_index
								});
								return;
							}
							if (event.type === "response.completed") {
								outputItemPhaseById.clear();
								outputTextByPart.clear();
								emittedTextByPart.clear();
								cleanup();
								session.lastContextLength = capturedContextLength;
								session.lastRequestPayload = fullPayload;
								session.lastResponseInputItems = convertResponseToInputItems(event.response, {
									api: model.api,
									provider: model.provider,
									id: model.id,
									input: model.input
								});
								const assistantMsg = buildAssistantMessageFromResponse(event.response, {
									api: model.api,
									provider: model.provider,
									id: model.id
								});
								const reason = assistantMsg.stopReason === "toolUse" ? "toolUse" : "stop";
								eventStream.push({
									type: "done",
									reason,
									message: assistantMsg
								});
								resolve();
							} else if (event.type === "response.failed") {
								outputItemPhaseById.clear();
								outputTextByPart.clear();
								emittedTextByPart.clear();
								cleanup();
								reject(new OpenAIWebSocketRuntimeError(`OpenAI WebSocket response failed: ${formatOpenAIWebSocketResponseFailure(event.response)}`, {
									kind: "server",
									retryable: false
								}));
							} else if (event.type === "error") {
								outputItemPhaseById.clear();
								outputTextByPart.clear();
								emittedTextByPart.clear();
								cleanup();
								reject(new OpenAIWebSocketRuntimeError(`OpenAI WebSocket error: ${formatOpenAIWebSocketError(event)}`, {
									kind: "server",
									retryable: false
								}));
							}
						});
					});
					return;
				} catch (wsRunErr) {
					const normalizedErr = normalizeWsRunError(wsRunErr);
					if (transport !== "websocket" && !signal?.aborted && normalizedErr.retryable && !sawWsOutput && runtimeRetries < MAX_AUTO_WS_RUNTIME_RETRIES) {
						runtimeRetries++;
						log$1.warn(`[ws-stream] retrying websocket turn after retryable runtime failure for session=${sessionId} (${runtimeRetries}/${MAX_AUTO_WS_RUNTIME_RETRIES}). error=${normalizedErr.message}`);
						resetWsSession({
							session,
							createManager: () => createWsManager(opts.managerOptions, sessionHeaders)
						});
						continue;
					}
					if (transport !== "websocket" && !signal?.aborted && !sawWsOutput) {
						log$1.warn(`[ws-stream] session=${sessionId} runtime failure before output; falling back to HTTP. error=${normalizedErr.message}`);
						markWsSessionDegraded(session);
						resetWsSession({
							session,
							createManager: () => createWsManager(opts.managerOptions, sessionHeaders),
							preserveDegradeUntil: true
						});
						return fallbackToHttp(model, context, options, apiKey, eventStream, opts.signal, {
							suppressStart: true,
							turnState: resolveProviderTransportTurnState(model, {
								sessionId,
								turnId,
								attempt: turnAttempt,
								transport: "stream"
							})
						});
					}
					throw normalizedErr;
				}
			}
		};
		queueMicrotask(() => run().catch((err) => {
			const errorMessage = formatErrorMessage(err);
			log$1.warn(`[ws-stream] session=${sessionId} run error: ${errorMessage}`);
			eventStream.push({
				type: "error",
				reason: "error",
				error: buildStreamErrorAssistantMessage({
					model,
					errorMessage
				})
			});
			eventStream.end();
		}));
		return eventStream;
	};
}
/**
* Fall back to HTTP and pipe events into the existing stream.
* This is called when the WebSocket is broken or unavailable.
*/
async function fallbackToHttp(model, context, streamOptions, apiKey, eventStream, signal, fallbackOptions) {
	const baseOnPayload = streamOptions?.onPayload;
	const mergedOptions = {
		...streamOptions,
		apiKey,
		...fallbackOptions?.turnState?.headers ? { headers: {
			...streamOptions?.headers,
			...fallbackOptions.turnState.headers
		} } : {},
		...fallbackOptions?.turnState?.metadata ? { onPayload: async (payload, payloadModel) => {
			return mergeTransportMetadata(await baseOnPayload?.(payload, payloadModel) ?? payload, fallbackOptions.turnState?.metadata);
		} } : {},
		...signal ? { signal } : {}
	};
	const httpStream = await (openAIWsStreamDeps.createHttpFallbackStreamFn(model) ?? openAIWsStreamDeps.streamSimple)(model, context, mergedOptions);
	for await (const event of httpStream) {
		if (fallbackOptions?.suppressStart && event.type === "start") continue;
		eventStream.push(event);
	}
	eventStream.end();
}
//#endregion
//#region src/agents/pi-embedded-runner/empty-assistant-turn.ts
function readFiniteTokenCount(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function isZero(value) {
	return value === 0;
}
function hasZeroTokenUsageSnapshot(usage) {
	if (!usage || typeof usage !== "object") return false;
	const typed = usage;
	const input = readFiniteTokenCount(typed.input);
	const output = readFiniteTokenCount(typed.output);
	const cacheRead = readFiniteTokenCount(typed.cacheRead);
	const cacheWrite = readFiniteTokenCount(typed.cacheWrite);
	const total = readFiniteTokenCount(typed.total ?? typed.totalTokens ?? typed.total_tokens);
	if (total !== void 0) return total === 0 && [
		input,
		output,
		cacheRead,
		cacheWrite
	].every((value) => value === void 0 || value === 0);
	const components = [
		input,
		output,
		cacheRead,
		cacheWrite
	].filter((value) => value !== void 0);
	return components.length > 0 && components.every(isZero);
}
function isZeroUsageEmptyStopAssistantTurn(message) {
	return Boolean(message && message.stopReason === "stop" && Array.isArray(message.content) && message.content.length === 0 && hasZeroTokenUsageSnapshot(message.usage));
}
//#endregion
//#region src/agents/pi-embedded-runner/thinking.ts
const OMITTED_ASSISTANT_REASONING_TEXT = "[assistant reasoning omitted]";
function isAssistantMessageWithContent(message) {
	return !!message && typeof message === "object" && message.role === "assistant" && Array.isArray(message.content);
}
function isThinkingBlock(block) {
	return !!block && typeof block === "object" && (block.type === "thinking" || block.type === "redacted_thinking");
}
function isToolCallBlock$1(block) {
	if (!block || typeof block !== "object") return false;
	const type = block.type;
	return type === "toolCall" || type === "tool_use" || type === "function_call";
}
function hasAssistantToolCall(message) {
	return message.content.some((block) => isToolCallBlock$1(block));
}
function isToolResultMessage(message) {
	return !!message && typeof message === "object" && message.role === "toolResult";
}
function isSignedThinkingBlock(block) {
	if (!isThinkingBlock(block)) return false;
	const record = block;
	return record.type === "redacted_thinking" || record.signature != null || record.thinkingSignature != null || record.thought_signature != null;
}
function hasMeaningfulText$1(block) {
	if (!block || typeof block !== "object" || block.type !== "text") return false;
	return typeof block.text === "string" ? block.text.trim().length > 0 : false;
}
function buildOmittedAssistantReasoningContent() {
	return [{
		type: "text",
		text: OMITTED_ASSISTANT_REASONING_TEXT
	}];
}
function hasReplayableThinkingSignature(block) {
	if (!isThinkingBlock(block)) return false;
	const record = block;
	return (block.type === "redacted_thinking" ? [
		record.data,
		record.signature,
		record.thinkingSignature,
		record.thought_signature
	] : [
		record.signature,
		record.thinkingSignature,
		record.thought_signature
	]).some((signature) => {
		return typeof signature === "string" && signature.trim().length > 0;
	});
}
/**
* Strip thinking blocks with clearly invalid replay signatures.
*
* Anthropic and Bedrock reject persisted thinking blocks when the signature is
* absent, empty, or blank. They are also the authority for opaque signature
* validity, so this intentionally avoids local length or shape heuristics.
*/
function stripInvalidThinkingSignatures(messages) {
	let touched = false;
	const out = [];
	for (const message of messages) {
		if (!isAssistantMessageWithContent(message)) {
			out.push(message);
			continue;
		}
		const nextContent = [];
		let changed = false;
		for (const block of message.content) {
			if (!isThinkingBlock(block) || hasReplayableThinkingSignature(block)) {
				nextContent.push(block);
				continue;
			}
			changed = true;
			touched = true;
		}
		if (!changed) {
			out.push(message);
			continue;
		}
		out.push({
			...message,
			content: nextContent.length > 0 ? nextContent : buildOmittedAssistantReasoningContent()
		});
	}
	return touched ? out : messages;
}
/**
* Strip `type: "thinking"` and `type: "redacted_thinking"` content blocks from
* all assistant messages except the latest one.
*
* Thinking blocks in the latest assistant turn are preserved verbatim so
* providers that require replay signatures can continue the conversation.
*
* If a non-latest assistant message becomes empty after stripping, it is
* replaced with a synthetic non-empty text block to preserve turn structure
* through provider adapters that filter blank text blocks.
*
* Returns the original array reference when nothing was changed (callers can
* use reference equality to skip downstream work).
*/
function dropThinkingBlocks(messages) {
	let latestAssistantIndex = -1;
	for (let i = messages.length - 1; i >= 0; i -= 1) if (isAssistantMessageWithContent(messages[i])) {
		latestAssistantIndex = i;
		break;
	}
	let touched = false;
	const out = [];
	for (let i = 0; i < messages.length; i += 1) {
		const msg = messages[i];
		if (!isAssistantMessageWithContent(msg)) {
			out.push(msg);
			continue;
		}
		if (i === latestAssistantIndex) {
			out.push(msg);
			continue;
		}
		const nextContent = [];
		let changed = false;
		for (const block of msg.content) {
			if (isThinkingBlock(block)) {
				touched = true;
				changed = true;
				continue;
			}
			nextContent.push(block);
		}
		if (!changed) {
			out.push(msg);
			continue;
		}
		const content = nextContent.length > 0 ? nextContent : buildOmittedAssistantReasoningContent();
		out.push({
			...msg,
			content
		});
	}
	return touched ? out : messages;
}
function shouldPreserveCurrentToolTurnReasoning(messages, index, latestUserIndex) {
	const message = messages[index];
	if (index < latestUserIndex || !isAssistantMessageWithContent(message) || !hasAssistantToolCall(message)) return false;
	for (let i = index - 1; i >= 0; i -= 1) {
		const role = messages[i]?.role;
		if (role === "user") break;
		if (role === "assistant") return false;
	}
	for (let i = index + 1; i < messages.length; i += 1) {
		const next = messages[i];
		const role = next?.role;
		if (isToolResultMessage(next)) return true;
		if (role === "user") return false;
	}
	return false;
}
function dropReasoningFromHistory(messages) {
	let latestUserIndex = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index]?.role === "user") {
		latestUserIndex = index;
		break;
	}
	let touched = false;
	const out = [];
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (!isAssistantMessageWithContent(message)) {
			out.push(message);
			continue;
		}
		if (shouldPreserveCurrentToolTurnReasoning(messages, index, latestUserIndex)) {
			out.push(message);
			continue;
		}
		const nextContent = message.content.filter((block) => !isThinkingBlock(block));
		if (nextContent.length === message.content.length) {
			out.push(message);
			continue;
		}
		touched = true;
		out.push({
			...message,
			content: nextContent.length > 0 ? nextContent : buildOmittedAssistantReasoningContent()
		});
	}
	return touched ? out : messages;
}
function assessLastAssistantMessage(message) {
	if (!isAssistantMessageWithContent(message)) return "valid";
	if (message.content.length === 0) return "incomplete-thinking";
	let hasSignedThinking = false;
	let hasUnsignedThinking = false;
	let hasNonThinkingContent = false;
	let hasEmptyTextBlock = false;
	for (const block of message.content) {
		if (!block || typeof block !== "object") return "incomplete-thinking";
		if (isThinkingBlock(block)) {
			if (isSignedThinkingBlock(block)) hasSignedThinking = true;
			else hasUnsignedThinking = true;
			continue;
		}
		hasNonThinkingContent = true;
		if (block.type === "text" && !hasMeaningfulText$1(block)) hasEmptyTextBlock = true;
	}
	if (hasUnsignedThinking) return "incomplete-thinking";
	if (hasSignedThinking && !hasNonThinkingContent) return "incomplete-text";
	if (hasSignedThinking && hasEmptyTextBlock) return "incomplete-text";
	return "valid";
}
//#endregion
//#region src/config/channel-capabilities.ts
const isStringArray = (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string");
function normalizeCapabilities(capabilities) {
	if (!isStringArray(capabilities)) return;
	const normalized = capabilities.map((entry) => entry.trim()).filter(Boolean);
	return normalized.length > 0 ? normalized : void 0;
}
function resolveAccountCapabilities(params) {
	const cfg = params.cfg;
	if (!cfg) return;
	const normalizedAccountId = normalizeAccountId(params.accountId);
	const accounts = cfg.accounts;
	if (accounts && typeof accounts === "object") {
		const match = resolveAccountEntry(accounts, normalizedAccountId);
		if (match) return normalizeCapabilities(match.capabilities) ?? normalizeCapabilities(cfg.capabilities);
	}
	return normalizeCapabilities(cfg.capabilities);
}
function resolveChannelCapabilities(params) {
	const cfg = params.cfg;
	const channel = normalizeAnyChannelId(params.channel);
	if (!cfg || !channel) return;
	return resolveAccountCapabilities({
		cfg: cfg.channels?.[channel] ?? cfg[channel],
		accountId: params.accountId
	});
}
//#endregion
//#region src/agents/runtime-capabilities.ts
const THREAD_BOUND_SUBAGENT_SPAWN_CAPABILITY = "threadbound-subagent-spawn";
const THREAD_BOUND_ACP_SPAWN_CAPABILITY = "threadbound-acp-spawn";
function mergeRuntimeCapabilities(base, additions = []) {
	const merged = [...base ?? []];
	const seen = new Set(merged.map((capability) => normalizeOptionalLowercaseString(capability)).filter(Boolean));
	for (const capability of additions) {
		const normalizedCapability = normalizeOptionalLowercaseString(capability);
		if (!normalizedCapability || seen.has(normalizedCapability)) continue;
		seen.add(normalizedCapability);
		merged.push(capability);
	}
	return merged.length > 0 ? merged : void 0;
}
function collectRuntimeChannelCapabilities(params) {
	if (!params.channel) return;
	const threadSpawnCapabilities = [];
	if (params.cfg && supportsAutomaticThreadBindingSpawn(params.channel)) for (const [kind, capability] of [["subagent", THREAD_BOUND_SUBAGENT_SPAWN_CAPABILITY], ["acp", THREAD_BOUND_ACP_SPAWN_CAPABILITY]]) {
		const policy = resolveThreadBindingSpawnPolicy({
			cfg: params.cfg,
			channel: params.channel,
			accountId: params.accountId ?? void 0,
			kind
		});
		if (policy.enabled && policy.spawnEnabled) threadSpawnCapabilities.push(capability);
	}
	return mergeRuntimeCapabilities(resolveChannelCapabilities(params), params.cfg ? [...resolveChannelPromptCapabilities(params), ...threadSpawnCapabilities] : threadSpawnCapabilities);
}
//#endregion
//#region src/agents/session-file-repair.ts
/** Placeholder for blank user messages — preserves the user turn so strict
* providers that require at least one user message don't reject the transcript. */
const BLANK_USER_FALLBACK_TEXT = "(continue)";
function isSessionHeader(entry) {
	if (!entry || typeof entry !== "object") return false;
	const record = entry;
	return record.type === "session" && typeof record.id === "string" && record.id.length > 0;
}
function isAssistantEntryWithEmptyContent(entry) {
	if (!entry || typeof entry !== "object") return false;
	const record = entry;
	if (record.type !== "message" || !record.message || typeof record.message !== "object") return false;
	const message = record.message;
	if (message.role !== "assistant") return false;
	if (!Array.isArray(message.content) || message.content.length !== 0) return false;
	return message.stopReason === "error";
}
function rewriteAssistantEntryWithEmptyContent(entry) {
	return {
		...entry,
		message: {
			...entry.message,
			content: [{
				type: "text",
				text: STREAM_ERROR_FALLBACK_TEXT
			}]
		}
	};
}
function repairUserEntryWithBlankTextContent(entry) {
	const content = entry.message.content;
	if (typeof content === "string") {
		if (content.trim()) return { kind: "keep" };
		return {
			kind: "rewrite",
			entry: {
				...entry,
				message: {
					...entry.message,
					content: BLANK_USER_FALLBACK_TEXT
				}
			}
		};
	}
	if (!Array.isArray(content)) return { kind: "keep" };
	let touched = false;
	const nextContent = content.filter((block) => {
		if (!block || typeof block !== "object") return true;
		if (block.type !== "text") return true;
		const text = block.text;
		if (typeof text !== "string" || text.trim().length > 0) return true;
		touched = true;
		return false;
	});
	if (nextContent.length === 0) return {
		kind: "rewrite",
		entry: {
			...entry,
			message: {
				...entry.message,
				content: [{
					type: "text",
					text: BLANK_USER_FALLBACK_TEXT
				}]
			}
		}
	};
	if (!touched) return { kind: "keep" };
	return {
		kind: "rewrite",
		entry: {
			...entry,
			message: {
				...entry.message,
				content: nextContent
			}
		}
	};
}
function isToolCallBlock(block) {
	if (!block || typeof block !== "object") return false;
	const type = block.type;
	return type === "toolCall" || type === "toolUse" || type === "functionCall";
}
/** Trailing assistant without tool calls — safe to trim from disk.
* Assistant turns with tool calls are kept so transcript repair can
* synthesize missing tool results (mirrors the outbound guard). */
function isTrimmableTrailingAssistantEntry(entry) {
	if (!entry || typeof entry !== "object") return false;
	const record = entry;
	if (record.type !== "message" || !record.message || typeof record.message !== "object") return false;
	const message = record.message;
	if (message.role !== "assistant") return false;
	const content = message.content;
	if (Array.isArray(content) && content.some(isToolCallBlock)) return false;
	return true;
}
function buildRepairSummaryParts(params) {
	const parts = [];
	if (params.droppedLines > 0) parts.push(`dropped ${params.droppedLines} malformed line(s)`);
	if (params.rewrittenAssistantMessages > 0) parts.push(`rewrote ${params.rewrittenAssistantMessages} assistant message(s)`);
	if (params.droppedBlankUserMessages > 0) parts.push(`dropped ${params.droppedBlankUserMessages} blank user message(s)`);
	if (params.rewrittenUserMessages > 0) parts.push(`rewrote ${params.rewrittenUserMessages} user message(s)`);
	if (params.trimmedTrailingAssistantMessages > 0) parts.push(`trimmed ${params.trimmedTrailingAssistantMessages} trailing assistant message(s)`);
	return parts.length > 0 ? parts.join(", ") : "no changes";
}
async function repairSessionFileIfNeeded(params) {
	const sessionFile = params.sessionFile.trim();
	if (!sessionFile) return {
		repaired: false,
		droppedLines: 0,
		reason: "missing session file"
	};
	let content;
	try {
		content = await fs$1.readFile(sessionFile, "utf-8");
	} catch (err) {
		if (err?.code === "ENOENT") return {
			repaired: false,
			droppedLines: 0,
			reason: "missing session file"
		};
		const reason = `failed to read session file: ${err instanceof Error ? err.message : "unknown error"}`;
		params.warn?.(`session file repair skipped: ${reason} (${path.basename(sessionFile)})`);
		return {
			repaired: false,
			droppedLines: 0,
			reason
		};
	}
	const lines = content.split(/\r?\n/);
	const entries = [];
	let droppedLines = 0;
	let rewrittenAssistantMessages = 0;
	let droppedBlankUserMessages = 0;
	let rewrittenUserMessages = 0;
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (isAssistantEntryWithEmptyContent(entry)) {
				entries.push(rewriteAssistantEntryWithEmptyContent(entry));
				rewrittenAssistantMessages += 1;
				continue;
			}
			if (entry && typeof entry === "object" && entry.type === "message" && typeof entry.message === "object" && (entry.message?.role ?? void 0) === "user") {
				const repairedUser = repairUserEntryWithBlankTextContent(entry);
				if (repairedUser.kind === "drop") {
					droppedBlankUserMessages += 1;
					continue;
				}
				if (repairedUser.kind === "rewrite") {
					entries.push(repairedUser.entry);
					rewrittenUserMessages += 1;
					continue;
				}
			}
			entries.push(entry);
		} catch {
			droppedLines += 1;
		}
	}
	if (entries.length === 0) return {
		repaired: false,
		droppedLines,
		reason: "empty session file"
	};
	if (!isSessionHeader(entries[0])) {
		params.warn?.(`session file repair skipped: invalid session header (${path.basename(sessionFile)})`);
		return {
			repaired: false,
			droppedLines,
			reason: "invalid session header"
		};
	}
	let trimmedTrailingAssistantMessages = 0;
	while (entries.length > 1 && isTrimmableTrailingAssistantEntry(entries[entries.length - 1])) {
		entries.pop();
		trimmedTrailingAssistantMessages += 1;
	}
	if (droppedLines === 0 && rewrittenAssistantMessages === 0 && droppedBlankUserMessages === 0 && rewrittenUserMessages === 0 && trimmedTrailingAssistantMessages === 0) return {
		repaired: false,
		droppedLines: 0
	};
	const cleaned = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	const backupPath = `${sessionFile}.bak-${process.pid}-${Date.now()}`;
	const tmpPath = `${sessionFile}.repair-${process.pid}-${Date.now()}.tmp`;
	try {
		const stat = await fs$1.stat(sessionFile).catch(() => null);
		await fs$1.writeFile(backupPath, content, "utf-8");
		if (stat) await fs$1.chmod(backupPath, stat.mode);
		await fs$1.writeFile(tmpPath, cleaned, "utf-8");
		if (stat) await fs$1.chmod(tmpPath, stat.mode);
		await fs$1.rename(tmpPath, sessionFile);
	} catch (err) {
		try {
			await fs$1.unlink(tmpPath);
		} catch (cleanupErr) {
			params.warn?.(`session file repair cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : "unknown error"} (${path.basename(tmpPath)})`);
		}
		return {
			repaired: false,
			droppedLines,
			rewrittenAssistantMessages,
			droppedBlankUserMessages,
			rewrittenUserMessages,
			trimmedTrailingAssistantMessages,
			reason: `repair failed: ${err instanceof Error ? err.message : "unknown error"}`
		};
	}
	params.debug?.(`session file repaired: ${buildRepairSummaryParts({
		droppedLines,
		rewrittenAssistantMessages,
		droppedBlankUserMessages,
		rewrittenUserMessages,
		trimmedTrailingAssistantMessages
	})} (${path.basename(sessionFile)})`);
	return {
		repaired: true,
		droppedLines,
		rewrittenAssistantMessages,
		droppedBlankUserMessages,
		rewrittenUserMessages,
		trimmedTrailingAssistantMessages,
		backupPath
	};
}
//#endregion
//#region src/agents/session-tool-result-state.ts
function createPendingToolCallState() {
	const pending = /* @__PURE__ */ new Map();
	return {
		size: () => pending.size,
		entries: () => pending.entries(),
		getToolName: (id) => pending.get(id),
		delete: (id) => {
			pending.delete(id);
		},
		clear: () => {
			pending.clear();
		},
		trackToolCalls: (calls) => {
			for (const call of calls) pending.set(call.id, call.name);
		},
		getPendingIds: () => Array.from(pending.keys()),
		shouldFlushForSanitizedDrop: () => pending.size > 0,
		shouldFlushBeforeNonToolResult: (nextRole, toolCallCount) => pending.size > 0 && (toolCallCount === 0 || nextRole !== "assistant"),
		shouldFlushBeforeNewToolCalls: (toolCallCount) => pending.size > 0 && toolCallCount > 0
	};
}
//#endregion
//#region src/agents/session-tool-result-guard.ts
/**
* Truncate oversized text content blocks in a tool result message.
* Returns the original message if under the limit, or a new message with
* truncated text blocks otherwise.
*/
function capToolResultSize(msg, maxChars) {
	if (msg.role !== "toolResult") return msg;
	return truncateToolResultMessage(msg, maxChars, {
		suffix: (truncatedChars) => formatContextLimitTruncationNotice(truncatedChars),
		minKeepChars: 2e3
	});
}
function resolveMaxToolResultChars(opts) {
	return Math.max(1, opts?.maxToolResultChars ?? 16e3);
}
const MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES = 8192;
const MAX_PERSISTED_DETAIL_STRING_CHARS = 2e3;
const MAX_PERSISTED_DETAIL_SESSION_COUNT = 10;
const MAX_PERSISTED_DETAIL_FALLBACK_STRING_CHARS = 200;
function originalDetailsSizeFields(size) {
	return size.complete ? { originalDetailsBytes: size.bytes } : { originalDetailsBytesAtLeast: size.bytes };
}
function truncatePersistedDetailString(value, maxChars = MAX_PERSISTED_DETAIL_STRING_CHARS) {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}\n\n[OpenClaw persisted detail truncated: ${value.length - maxChars} chars omitted]`;
}
function sanitizePersistedSessionDetail(value) {
	if (!value || typeof value !== "object") return value;
	const src = value;
	const out = {};
	for (const key of [
		"sessionId",
		"status",
		"pid",
		"startedAt",
		"endedAt",
		"runtimeMs",
		"cwd",
		"name",
		"truncated",
		"exitCode",
		"exitSignal"
	]) {
		const field = src[key];
		if (field !== void 0) out[key] = typeof field === "string" ? truncatePersistedDetailString(field, 500) : field;
	}
	if (typeof src.command === "string") out.command = truncatePersistedDetailString(src.command, 500);
	return out;
}
function buildPersistedDetailsFallback(src, originalSize, sanitizedBytes) {
	const fallback = {
		persistedDetailsTruncated: true,
		finalDetailsTruncated: true,
		...originalDetailsSizeFields(originalSize)
	};
	if (sanitizedBytes !== void 0) fallback.sanitizedDetailsBytes = sanitizedBytes;
	if (src) {
		fallback.originalDetailKeys = firstEnumerableOwnKeys(src, 40);
		for (const key of [
			"status",
			"sessionId",
			"pid",
			"exitCode",
			"exitSignal",
			"truncated"
		]) {
			const field = src[key];
			if (field !== void 0) fallback[key] = typeof field === "string" ? truncatePersistedDetailString(field, MAX_PERSISTED_DETAIL_FALLBACK_STRING_CHARS) : field;
		}
	}
	return fallback;
}
function enforcePersistedDetailsByteCap(value, src, originalSize) {
	const sanitizedBytes = jsonUtf8BytesOrInfinity(value);
	if (sanitizedBytes <= MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES) return value;
	const fallback = buildPersistedDetailsFallback(src, originalSize, sanitizedBytes);
	if (jsonUtf8BytesOrInfinity(fallback) <= MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES) return fallback;
	return {
		persistedDetailsTruncated: true,
		finalDetailsTruncated: true,
		...originalDetailsSizeFields(originalSize),
		sanitizedDetailsBytes: sanitizedBytes
	};
}
function sanitizeToolResultDetailsForPersistence(details) {
	if (details === void 0 || details === null) return details;
	const originalSize = boundedJsonUtf8Bytes(details, MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES);
	if (originalSize.complete && originalSize.bytes <= MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES) return details;
	if (typeof details !== "object") return enforcePersistedDetailsByteCap({
		persistedDetailsTruncated: true,
		...originalDetailsSizeFields(originalSize),
		valueType: typeof details
	}, void 0, originalSize);
	const src = details;
	const out = {
		persistedDetailsTruncated: true,
		...originalDetailsSizeFields(originalSize),
		originalDetailKeys: firstEnumerableOwnKeys(src, 40)
	};
	for (const key of [
		"status",
		"sessionId",
		"pid",
		"startedAt",
		"endedAt",
		"cwd",
		"name",
		"exitCode",
		"exitSignal",
		"retryInMs",
		"total",
		"totalLines",
		"totalChars",
		"truncated",
		"fullOutputPath",
		"truncation"
	]) {
		const field = src[key];
		if (field !== void 0) out[key] = typeof field === "string" ? truncatePersistedDetailString(field) : field;
	}
	if (typeof src.tail === "string") out.tail = truncatePersistedDetailString(src.tail);
	if (Array.isArray(src.sessions)) {
		out.sessions = src.sessions.slice(0, MAX_PERSISTED_DETAIL_SESSION_COUNT).map(sanitizePersistedSessionDetail);
		if (src.sessions.length > MAX_PERSISTED_DETAIL_SESSION_COUNT) out.sessionsTruncated = src.sessions.length - MAX_PERSISTED_DETAIL_SESSION_COUNT;
	}
	return enforcePersistedDetailsByteCap(out, src, originalSize);
}
function capToolResultDetails(msg) {
	if (msg.role !== "toolResult") return msg;
	const details = msg.details;
	const sanitizedDetails = sanitizeToolResultDetailsForPersistence(details);
	if (sanitizedDetails === details) return msg;
	const next = { ...msg };
	next.details = sanitizedDetails;
	return next;
}
function capToolResultForPersistence(msg, maxChars) {
	return capToolResultDetails(capToolResultSize(msg, maxChars));
}
function normalizePersistedToolResultName(message, fallbackName) {
	if (message.role !== "toolResult") return message;
	const toolResult = message;
	const rawToolName = toolResult.toolName;
	const normalizedToolName = normalizeOptionalString(rawToolName);
	if (normalizedToolName) {
		if (rawToolName === normalizedToolName) return toolResult;
		return {
			...toolResult,
			toolName: normalizedToolName
		};
	}
	const normalizedFallback = normalizeOptionalString(fallbackName);
	if (normalizedFallback) return {
		...toolResult,
		toolName: normalizedFallback
	};
	if (typeof rawToolName === "string") return {
		...toolResult,
		toolName: "unknown"
	};
	return toolResult;
}
function installSessionToolResultGuard(sessionManager, opts) {
	const originalAppend = getRawSessionAppendMessage(sessionManager);
	setRawSessionAppendMessage(sessionManager, originalAppend);
	const pendingState = createPendingToolCallState();
	const persistMessage = (message) => {
		const transformer = opts?.transformMessageForPersistence;
		return transformer ? transformer(message) : message;
	};
	const persistToolResult = (message, meta) => {
		const transformer = opts?.transformToolResultForPersistence;
		return transformer ? transformer(message, meta) : message;
	};
	const allowSyntheticToolResults = opts?.allowSyntheticToolResults ?? true;
	const missingToolResultText = opts?.missingToolResultText;
	const beforeWrite = opts?.beforeMessageWriteHook;
	const maxToolResultChars = resolveMaxToolResultChars(opts);
	/**
	* Run the before_message_write hook. Returns the (possibly modified) message,
	* or null if the message should be blocked.
	*/
	const applyBeforeWriteHook = (msg) => {
		if (!beforeWrite) return msg;
		const result = beforeWrite({ message: msg });
		if (result?.block) return null;
		if (result?.message) return result.message;
		return msg;
	};
	const flushPendingToolResults = () => {
		if (pendingState.size() === 0) return;
		if (allowSyntheticToolResults) for (const [id, name] of pendingState.entries()) {
			const flushed = applyBeforeWriteHook(persistToolResult(persistMessage(makeMissingToolResult({
				toolCallId: id,
				toolName: name,
				text: missingToolResultText
			})), {
				toolCallId: id,
				toolName: name,
				isSynthetic: true
			}));
			if (flushed) originalAppend(capToolResultForPersistence(flushed, maxToolResultChars));
		}
		pendingState.clear();
	};
	const clearPendingToolResults = () => {
		pendingState.clear();
	};
	const guardedAppend = (message) => {
		let nextMessage = message;
		if (message.role === "assistant") {
			const sanitized = sanitizeToolCallInputs([message], { allowedToolNames: opts?.allowedToolNames });
			if (sanitized.length === 0) {
				if (pendingState.shouldFlushForSanitizedDrop()) flushPendingToolResults();
				return;
			}
			nextMessage = sanitized[0];
		}
		const nextRole = nextMessage.role;
		if (nextRole === "toolResult") {
			const id = extractToolResultId(nextMessage);
			const toolName = id ? pendingState.getToolName(id) : void 0;
			if (id) pendingState.delete(id);
			const persisted = applyBeforeWriteHook(persistToolResult(capToolResultForPersistence(persistMessage(normalizePersistedToolResultName(nextMessage, toolName)), maxToolResultChars), {
				toolCallId: id ?? void 0,
				toolName,
				isSynthetic: false
			}));
			if (!persisted) return;
			return originalAppend(capToolResultForPersistence(persisted, maxToolResultChars));
		}
		const stopReason = nextMessage.stopReason;
		const toolCalls = nextRole === "assistant" && stopReason !== "aborted" && stopReason !== "error" ? extractToolCallsFromAssistant(nextMessage) : [];
		if (pendingState.shouldFlushBeforeNonToolResult(nextRole, toolCalls.length)) flushPendingToolResults();
		if (pendingState.shouldFlushBeforeNewToolCalls(toolCalls.length)) flushPendingToolResults();
		const finalMessage = applyBeforeWriteHook(persistMessage(nextMessage));
		if (!finalMessage) return;
		const result = originalAppend(finalMessage);
		const sessionFile = sessionManager.getSessionFile?.();
		if (sessionFile) emitSessionTranscriptUpdate({
			sessionFile,
			sessionKey: opts?.sessionKey,
			message: finalMessage,
			messageId: typeof result === "string" ? result : void 0
		});
		if (toolCalls.length > 0) pendingState.trackToolCalls(toolCalls);
		return result;
	};
	sessionManager.appendMessage = guardedAppend;
	return {
		flushPendingToolResults,
		clearPendingToolResults,
		getPendingIds: pendingState.getPendingIds
	};
}
//#endregion
//#region src/agents/session-tool-result-guard-wrapper.ts
function redactTranscriptText(value, cfg) {
	if (cfg?.logging?.redactSensitive === "off") return value;
	return redactSensitiveText(value, {
		mode: cfg?.logging?.redactSensitive,
		patterns: cfg?.logging?.redactPatterns
	});
}
function redactTranscriptContentBlock(block, cfg) {
	if (!block || typeof block !== "object" || Array.isArray(block)) return block;
	const source = block;
	let next = null;
	const assign = (key, value) => {
		const redacted = redactTranscriptText(value, cfg);
		if (redacted === value) return;
		next ??= { ...source };
		next[key] = redacted;
	};
	if (typeof source.text === "string") assign("text", source.text);
	if (typeof source.thinking === "string") assign("thinking", source.thinking);
	if (typeof source.partialJson === "string") assign("partialJson", source.partialJson);
	return next ?? block;
}
function redactTranscriptContent(content, cfg) {
	if (typeof content === "string") return redactTranscriptText(content, cfg);
	if (!Array.isArray(content)) return content;
	let changed = false;
	const redacted = content.map((block) => {
		const next = redactTranscriptContentBlock(block, cfg);
		changed ||= next !== block;
		return next;
	});
	return changed ? redacted : content;
}
function redactTranscriptMessage(message, cfg) {
	const source = message;
	const redactedContent = redactTranscriptContent(source.content, cfg);
	if (redactedContent === source.content) return message;
	return {
		...source,
		content: redactedContent
	};
}
/**
* Apply the tool-result guard to a SessionManager exactly once and expose
* a flush method on the instance for easy teardown handling.
*/
function guardSessionManager(sessionManager, opts) {
	if (typeof sessionManager.flushPendingToolResults === "function") return sessionManager;
	const hookRunner = getGlobalHookRunner();
	const beforeMessageWrite = (event) => {
		let message = event.message;
		let changed = false;
		if (hookRunner?.hasHooks("before_message_write")) {
			const result = hookRunner.runBeforeMessageWrite(event, {
				agentId: opts?.agentId,
				sessionKey: opts?.sessionKey
			});
			if (result?.block) return result;
			if (result?.message) {
				message = result.message;
				changed = true;
			}
		}
		const redacted = redactTranscriptMessage(message, opts?.config);
		if (redacted !== message) {
			message = redacted;
			changed = true;
		}
		return changed ? { message } : void 0;
	};
	const transform = hookRunner?.hasHooks("tool_result_persist") ? (message, meta) => {
		return hookRunner.runToolResultPersist({
			toolName: meta.toolName,
			toolCallId: meta.toolCallId,
			message,
			isSynthetic: meta.isSynthetic
		}, {
			agentId: opts?.agentId,
			sessionKey: opts?.sessionKey,
			toolName: meta.toolName,
			toolCallId: meta.toolCallId
		})?.message ?? message;
	} : void 0;
	const guard = installSessionToolResultGuard(sessionManager, {
		sessionKey: opts?.sessionKey,
		transformMessageForPersistence: (message) => applyInputProvenanceToUserMessage(message, opts?.inputProvenance),
		transformToolResultForPersistence: transform,
		allowSyntheticToolResults: opts?.allowSyntheticToolResults,
		missingToolResultText: opts?.missingToolResultText,
		allowedToolNames: opts?.allowedToolNames,
		beforeMessageWriteHook: beforeMessageWrite,
		maxToolResultChars: typeof opts?.contextWindowTokens === "number" ? resolveLiveToolResultMaxChars({
			contextWindowTokens: opts.contextWindowTokens,
			cfg: opts.config,
			agentId: opts.agentId
		}) : void 0
	});
	sessionManager.flushPendingToolResults = guard.flushPendingToolResults;
	sessionManager.clearPendingToolResults = guard.clearPendingToolResults;
	return sessionManager;
}
//#endregion
//#region src/agents/pi-embedded-runner/cache-ttl.ts
const CACHE_TTL_CUSTOM_TYPE = "openclaw.cache-ttl";
function isCacheTtlEligibleProvider(provider, modelId, modelApi) {
	const normalizedProvider = normalizeLowercaseStringOrEmpty(provider);
	const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
	const pluginEligibility = resolveProviderCacheTtlEligibility({
		provider: normalizedProvider,
		context: {
			provider: normalizedProvider,
			modelId: normalizedModelId,
			modelApi
		}
	});
	if (pluginEligibility !== void 0) return pluginEligibility;
	return isAnthropicFamilyCacheTtlEligible({
		provider: normalizedProvider,
		modelId: normalizedModelId,
		modelApi
	}) || normalizedProvider === "kilocode" && isAnthropicModelRef(normalizedModelId) || isGooglePromptCacheEligible({
		modelApi,
		modelId: normalizedModelId
	});
}
function normalizeCacheTtlKey(value) {
	return normalizeOptionalLowercaseString(value);
}
function matchesCacheTtlContext(data, context) {
	if (!context) return true;
	const expectedProvider = normalizeCacheTtlKey(context.provider);
	if (expectedProvider && normalizeCacheTtlKey(data?.provider) !== expectedProvider) return false;
	const expectedModelId = normalizeCacheTtlKey(context.modelId);
	if (expectedModelId && normalizeCacheTtlKey(data?.modelId) !== expectedModelId) return false;
	return true;
}
function readLastCacheTtlTimestamp(sessionManager, context) {
	const sm = sessionManager;
	if (!sm?.getEntries) return null;
	try {
		const entries = sm.getEntries();
		let last = null;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry?.type !== "custom" || entry?.customType !== CACHE_TTL_CUSTOM_TYPE) continue;
			const data = entry?.data;
			if (!matchesCacheTtlContext(data, context)) continue;
			const ts = typeof data?.timestamp === "number" ? data.timestamp : null;
			if (ts && Number.isFinite(ts)) {
				last = ts;
				break;
			}
		}
		return last;
	} catch {
		return null;
	}
}
//#endregion
//#region src/node-host/with-timeout.ts
async function withTimeout(work, timeoutMs, label) {
	const resolved = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? Math.max(1, Math.floor(timeoutMs)) : void 0;
	if (!resolved) return await work(void 0);
	const abortCtrl = new AbortController();
	const timeoutError = /* @__PURE__ */ new Error(`${label ?? "request"} timed out`);
	const timer = setTimeout(() => abortCtrl.abort(timeoutError), resolved);
	timer.unref?.();
	let abortListener;
	const abortPromise = abortCtrl.signal.aborted ? Promise.reject(abortCtrl.signal.reason ?? timeoutError) : new Promise((_, reject) => {
		abortListener = () => reject(abortCtrl.signal.reason ?? timeoutError);
		abortCtrl.signal.addEventListener("abort", abortListener, { once: true });
	});
	try {
		return await Promise.race([work(abortCtrl.signal), abortPromise]);
	} finally {
		clearTimeout(timer);
		if (abortListener) abortCtrl.signal.removeEventListener("abort", abortListener);
	}
}
//#endregion
//#region src/agents/pi-embedded-runner/compaction-safety-timeout.ts
const EMBEDDED_COMPACTION_TIMEOUT_MS = 9e5;
const MAX_SAFE_TIMEOUT_MS = 2147e6;
function createAbortError(signal) {
	const reason = "reason" in signal ? signal.reason : void 0;
	if (reason instanceof Error) return reason;
	const err = reason ? new Error("aborted", { cause: reason }) : /* @__PURE__ */ new Error("aborted");
	err.name = "AbortError";
	return err;
}
function resolveCompactionTimeoutMs(cfg) {
	const raw = cfg?.agents?.defaults?.compaction?.timeoutSeconds;
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.min(Math.floor(raw) * 1e3, MAX_SAFE_TIMEOUT_MS);
	return EMBEDDED_COMPACTION_TIMEOUT_MS;
}
async function compactWithSafetyTimeout(compact, timeoutMs = EMBEDDED_COMPACTION_TIMEOUT_MS, opts) {
	let canceled = false;
	const cancel = () => {
		if (canceled) return;
		canceled = true;
		try {
			opts?.onCancel?.();
		} catch {}
	};
	return await withTimeout(async (timeoutSignal) => {
		let timeoutListener;
		let externalAbortListener;
		let externalAbortPromise;
		const abortSignal = opts?.abortSignal;
		if (timeoutSignal) {
			timeoutListener = () => {
				cancel();
			};
			timeoutSignal.addEventListener("abort", timeoutListener, { once: true });
		}
		if (abortSignal) {
			if (abortSignal.aborted) {
				cancel();
				throw createAbortError(abortSignal);
			}
			externalAbortPromise = new Promise((_, reject) => {
				externalAbortListener = () => {
					cancel();
					reject(createAbortError(abortSignal));
				};
				abortSignal.addEventListener("abort", externalAbortListener, { once: true });
			});
		}
		try {
			if (externalAbortPromise) return await Promise.race([compact(), externalAbortPromise]);
			return await compact();
		} finally {
			if (timeoutListener) timeoutSignal?.removeEventListener("abort", timeoutListener);
			if (externalAbortListener) abortSignal?.removeEventListener("abort", externalAbortListener);
		}
	}, timeoutMs, "Compaction");
}
//#endregion
//#region src/agents/pi-hooks/session-manager-runtime-registry.ts
function createSessionManagerRuntimeRegistry() {
	const registry = /* @__PURE__ */ new WeakMap();
	const set = (sessionManager, value) => {
		if (!sessionManager || typeof sessionManager !== "object") return;
		const key = sessionManager;
		if (value === null) {
			registry.delete(key);
			return;
		}
		registry.set(key, value);
	};
	const get = (sessionManager) => {
		if (!sessionManager || typeof sessionManager !== "object") return null;
		return registry.get(sessionManager) ?? null;
	};
	return {
		set,
		get
	};
}
//#endregion
//#region src/agents/pi-hooks/compaction-safeguard-runtime.ts
const registry$1 = createSessionManagerRuntimeRegistry();
const setCompactionSafeguardRuntime = registry$1.set;
const getCompactionSafeguardRuntime = registry$1.get;
function setCompactionSafeguardCancelReason(sessionManager, reason) {
	const current = getCompactionSafeguardRuntime(sessionManager);
	const trimmed = reason?.trim();
	if (!current) {
		if (!trimmed) return;
		setCompactionSafeguardRuntime(sessionManager, { cancelReason: trimmed });
		return;
	}
	const next = { ...current };
	if (trimmed) next.cancelReason = trimmed;
	else delete next.cancelReason;
	setCompactionSafeguardRuntime(sessionManager, next);
}
function consumeCompactionSafeguardCancelReason(sessionManager) {
	const current = getCompactionSafeguardRuntime(sessionManager);
	const reason = current?.cancelReason?.trim();
	if (!reason) return null;
	const next = { ...current };
	delete next.cancelReason;
	setCompactionSafeguardRuntime(sessionManager, Object.keys(next).length > 0 ? next : null);
	return reason;
}
//#endregion
//#region src/auto-reply/reply/post-compaction-context.ts
const MAX_CONTEXT_CHARS = 1800;
const DEFAULT_POST_COMPACTION_SECTIONS = ["Session Startup", "Red Lines"];
const LEGACY_POST_COMPACTION_SECTIONS = ["Every Session", "Safety"];
function matchesSectionSet(sectionNames, expectedSections) {
	if (sectionNames.length !== expectedSections.length) return false;
	const counts = /* @__PURE__ */ new Map();
	for (const name of expectedSections) {
		const normalized = normalizeLowercaseStringOrEmpty(name);
		counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
	}
	for (const name of sectionNames) {
		const normalized = normalizeLowercaseStringOrEmpty(name);
		const count = counts.get(normalized);
		if (!count) return false;
		if (count === 1) counts.delete(normalized);
		else counts.set(normalized, count - 1);
	}
	return counts.size === 0;
}
function formatDateStamp(nowMs, timezone) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit"
	}).formatToParts(new Date(nowMs));
	const year = parts.find((p) => p.type === "year")?.value;
	const month = parts.find((p) => p.type === "month")?.value;
	const day = parts.find((p) => p.type === "day")?.value;
	if (year && month && day) return `${year}-${month}-${day}`;
	return new Date(nowMs).toISOString().slice(0, 10);
}
async function readPostCompactionContext(workspaceDir, options) {
	const cfg = options?.cfg;
	const agentId = options?.agentId;
	const effectiveNowMs = options?.nowMs;
	const agentsPath = path.join(workspaceDir, "AGENTS.md");
	try {
		const opened = await openBoundaryFile({
			absolutePath: agentsPath,
			rootPath: workspaceDir,
			boundaryLabel: "workspace root"
		});
		if (!opened.ok) return null;
		const content = (() => {
			try {
				return fs.readFileSync(opened.fd, "utf-8");
			} finally {
				fs.closeSync(opened.fd);
			}
		})();
		const configuredSections = cfg?.agents?.defaults?.compaction?.postCompactionSections;
		const sectionNames = Array.isArray(configuredSections) ? configuredSections : DEFAULT_POST_COMPACTION_SECTIONS;
		if (sectionNames.length === 0) return null;
		const foundSectionNames = [];
		let sections = extractSections(content, sectionNames, foundSectionNames);
		const isDefaultSections = !Array.isArray(configuredSections) || matchesSectionSet(configuredSections, DEFAULT_POST_COMPACTION_SECTIONS);
		if (sections.length === 0 && isDefaultSections) sections = extractSections(content, LEGACY_POST_COMPACTION_SECTIONS, foundSectionNames);
		if (sections.length === 0) return null;
		const displayNames = foundSectionNames.length > 0 ? foundSectionNames : sectionNames;
		const resolvedNowMs = effectiveNowMs ?? Date.now();
		const dateStamp = formatDateStamp(resolvedNowMs, resolveUserTimezone(cfg?.agents?.defaults?.userTimezone));
		const maxContextChars = resolveAgentContextLimits(cfg, agentId)?.postCompactionMaxChars ?? MAX_CONTEXT_CHARS;
		const { timeLine } = resolveCronStyleNow(cfg ?? {}, resolvedNowMs);
		const combined = sections.join("\n\n").replaceAll("YYYY-MM-DD", dateStamp);
		const safeContent = combined.length > maxContextChars ? combined.slice(0, maxContextChars) + "\n...[truncated]..." : combined;
		return `[Post-compaction context refresh]

${isDefaultSections ? "Session was just compacted. The conversation summary above is a hint, NOT a substitute for your startup sequence. Run your Session Startup sequence - read the required files before responding to the user." : `Session was just compacted. The conversation summary above is a hint, NOT a substitute for your full startup sequence. Re-read the sections injected below (${displayNames.join(", ")}) and follow your configured startup procedure before responding to the user.`}\n\n${isDefaultSections ? "Critical rules from AGENTS.md:" : `Injected sections from AGENTS.md (${displayNames.join(", ")}):`}\n\n${safeContent}\n\n${timeLine}`;
	} catch {
		return null;
	}
}
/**
* Extract named sections from markdown content.
* Matches H2 (##) or H3 (###) headings case-insensitively.
* Skips content inside fenced code blocks.
* Captures until the next heading of same or higher level, or end of string.
*/
function extractSections(content, sectionNames, foundNames) {
	const results = [];
	const lines = content.split("\n");
	for (const name of sectionNames) {
		let sectionLines = [];
		let inSection = false;
		let sectionLevel = 0;
		let inCodeBlock = false;
		for (const line of lines) {
			if (line.trimStart().startsWith("```")) {
				inCodeBlock = !inCodeBlock;
				if (inSection) sectionLines.push(line);
				continue;
			}
			if (inCodeBlock) {
				if (inSection) sectionLines.push(line);
				continue;
			}
			const headingMatch = line.match(/^(#{2,3})\s+(.+?)\s*$/);
			if (headingMatch) {
				const level = headingMatch[1].length;
				const headingText = headingMatch[2];
				if (!inSection) {
					if (normalizeLowercaseStringOrEmpty(headingText) === normalizeLowercaseStringOrEmpty(name)) {
						inSection = true;
						sectionLevel = level;
						sectionLines = [line];
						continue;
					}
				} else {
					if (level <= sectionLevel) break;
					sectionLines.push(line);
					continue;
				}
			}
			if (inSection) sectionLines.push(line);
		}
		if (sectionLines.length > 0) {
			results.push(sectionLines.join("\n").trim());
			foundNames?.push(name);
		}
	}
	return results;
}
//#endregion
//#region src/agents/compaction-real-conversation.ts
const TOOL_RESULT_REAL_CONVERSATION_LOOKBACK = 20;
const NON_CONVERSATION_BLOCK_TYPES = new Set([
	"toolCall",
	"toolUse",
	"functionCall",
	"thinking",
	"reasoning"
]);
function hasMeaningfulText(text) {
	const trimmed = text.trim();
	if (!trimmed) return false;
	if (isSilentReplyText(trimmed)) return false;
	const heartbeat = stripHeartbeatToken(trimmed, { mode: "message" });
	if (heartbeat.didStrip) return heartbeat.text.trim().length > 0;
	return true;
}
function hasMeaningfulConversationContent(message) {
	const content = message.content;
	if (typeof content === "string") return hasMeaningfulText(content);
	if (!Array.isArray(content)) return false;
	let sawMeaningfulNonTextBlock = false;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const type = block.type;
		if (type !== "text") {
			if (typeof type === "string" && NON_CONVERSATION_BLOCK_TYPES.has(type)) continue;
			sawMeaningfulNonTextBlock = true;
			continue;
		}
		const text = block.text;
		if (typeof text !== "string") continue;
		if (hasMeaningfulText(text)) return true;
	}
	return sawMeaningfulNonTextBlock;
}
function isRealConversationMessage(message, messages, index) {
	if (message.role === "user" || message.role === "assistant") return hasMeaningfulConversationContent(message);
	if (message.role !== "toolResult") return false;
	const start = Math.max(0, index - TOOL_RESULT_REAL_CONVERSATION_LOOKBACK);
	for (let i = index - 1; i >= start; i -= 1) {
		const candidate = messages[i];
		if (!candidate || candidate.role !== "user") continue;
		if (hasMeaningfulConversationContent(candidate)) return true;
	}
	return false;
}
/**
* Upper bound on custom instruction length to prevent prompt bloat.
* ~800 chars ≈ ~200 tokens — keeps summarization quality stable.
*/
const MAX_INSTRUCTION_LENGTH = 800;
function truncateUnicodeSafe(s, maxCodePoints) {
	const chars = Array.from(s);
	if (chars.length <= maxCodePoints) return s;
	return chars.slice(0, maxCodePoints).join("");
}
function normalize(s) {
	if (s == null) return;
	const trimmed = s.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
/**
* Resolve compaction instructions with precedence:
*   event (SDK) → runtime (config) → DEFAULT constant.
*
* Each input is normalized first (trim + empty→undefined) so that blank
* strings don't short-circuit the fallback chain.
*/
function resolveCompactionInstructions(eventInstructions, runtimeInstructions) {
	return truncateUnicodeSafe(normalize(eventInstructions) ?? normalize(runtimeInstructions) ?? "Write the summary body in the primary language used in the conversation.\nFocus on factual content: what was discussed, decisions made, and current state.\nKeep the required summary structure and section headers unchanged.\nDo not translate or alter code, file paths, identifiers, or error messages.", MAX_INSTRUCTION_LENGTH);
}
/**
* Compose split-turn instructions by combining the SDK's turn-prefix
* instructions with the resolved compaction instructions.
*/
function composeSplitTurnInstructions(turnPrefixInstructions, resolvedInstructions) {
	return [
		turnPrefixInstructions,
		"Additional requirements:",
		resolvedInstructions
	].join("\n\n");
}
//#endregion
//#region src/agents/pi-hooks/compaction-safeguard-quality.ts
const MAX_EXTRACTED_IDENTIFIERS = 12;
const MAX_UNTRUSTED_INSTRUCTION_CHARS = 4e3;
const MAX_ASK_OVERLAP_TOKENS = 12;
const MIN_ASK_OVERLAP_TOKENS_FOR_DOUBLE_MATCH = 3;
const REQUIRED_SUMMARY_SECTIONS = [
	"## Decisions",
	"## Open TODOs",
	"## Constraints/Rules",
	"## Pending user asks",
	"## Exact identifiers"
];
const STRICT_EXACT_IDENTIFIERS_INSTRUCTION = "For ## Exact identifiers, preserve literal values exactly as seen (IDs, URLs, file paths, ports, hashes, dates, times).";
const POLICY_OFF_EXACT_IDENTIFIERS_INSTRUCTION = "For ## Exact identifiers, include identifiers only when needed for continuity; do not enforce literal-preservation rules.";
function wrapUntrustedInstructionBlock(label, text) {
	return wrapUntrustedPromptDataBlock({
		label,
		text,
		maxChars: MAX_UNTRUSTED_INSTRUCTION_CHARS
	});
}
function resolveExactIdentifierSectionInstruction(summarizationInstructions) {
	const policy = summarizationInstructions?.identifierPolicy ?? "strict";
	if (policy === "off") return POLICY_OFF_EXACT_IDENTIFIERS_INSTRUCTION;
	if (policy === "custom") {
		const custom = summarizationInstructions?.identifierInstructions?.trim();
		if (custom) {
			const customBlock = wrapUntrustedInstructionBlock("For ## Exact identifiers, apply this operator-defined policy text", custom);
			if (customBlock) return customBlock;
		}
	}
	return STRICT_EXACT_IDENTIFIERS_INSTRUCTION;
}
function buildCompactionStructureInstructions(customInstructions, summarizationInstructions) {
	const identifierSectionInstruction = resolveExactIdentifierSectionInstruction(summarizationInstructions);
	const sectionsTemplate = [
		"Produce a compact, factual summary with these exact section headings:",
		...REQUIRED_SUMMARY_SECTIONS,
		identifierSectionInstruction,
		"Do not omit unresolved asks from the user.",
		"When prior compaction summaries are present, re-distill them with new messages and remove stale duplicate detail."
	].join("\n");
	const custom = customInstructions?.trim();
	if (!custom) return sectionsTemplate;
	const customBlock = wrapUntrustedInstructionBlock("Additional context from /compact", custom);
	if (!customBlock) return sectionsTemplate;
	return `${sectionsTemplate}\n\n${customBlock}`;
}
function normalizedSummaryLines(summary) {
	return summary.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
}
function hasRequiredSummarySections(summary) {
	const lines = normalizedSummaryLines(summary);
	let cursor = 0;
	for (const heading of REQUIRED_SUMMARY_SECTIONS) {
		const index = lines.findIndex((line, lineIndex) => lineIndex >= cursor && line === heading);
		if (index < 0) return false;
		cursor = index + 1;
	}
	return true;
}
function buildStructuredFallbackSummary(previousSummary, _summarizationInstructions) {
	const trimmedPreviousSummary = previousSummary?.trim() ?? "";
	if (trimmedPreviousSummary && hasRequiredSummarySections(trimmedPreviousSummary)) return trimmedPreviousSummary;
	return [
		"## Decisions",
		trimmedPreviousSummary || "No prior history.",
		"",
		"## Open TODOs",
		"None.",
		"",
		"## Constraints/Rules",
		"None.",
		"",
		"## Pending user asks",
		"None.",
		"",
		"## Exact identifiers",
		"None captured."
	].join("\n");
}
function appendSummarySection(summary, section) {
	if (!section) return summary;
	if (!summary.trim()) return section.trimStart();
	return `${summary}${section}`;
}
function sanitizeExtractedIdentifier(value) {
	return value.trim().replace(/^[("'`[{<]+/, "").replace(/[)\]"'`,;:.!?<>]+$/, "");
}
function isPureHexIdentifier(value) {
	return /^[A-Fa-f0-9]{8,}$/.test(value);
}
function normalizeOpaqueIdentifier(value) {
	return isPureHexIdentifier(value) ? value.toUpperCase() : value;
}
function summaryIncludesIdentifier(summary, identifier) {
	if (isPureHexIdentifier(identifier)) return summary.toUpperCase().includes(identifier.toUpperCase());
	return summary.includes(identifier);
}
function extractOpaqueIdentifiers(text) {
	const matches = text.match(/([A-Fa-f0-9]{8,}|https?:\/\/\S+|\/[\w.-]{2,}(?:\/[\w.-]+)+|[A-Za-z]:\\[\w\\.-]+|[A-Za-z0-9._-]+\.[A-Za-z0-9._/-]+:\d{1,5}|\b\d{6,}\b)/g) ?? [];
	return Array.from(new Set(matches.map((value) => sanitizeExtractedIdentifier(value)).map((value) => normalizeOpaqueIdentifier(value)).filter((value) => value.length >= 4))).slice(0, MAX_EXTRACTED_IDENTIFIERS);
}
function tokenizeAskOverlapText(text) {
	const normalized = localeLowercasePreservingWhitespace(text.normalize("NFKC")).trim();
	if (!normalized) return [];
	const keywords = extractKeywords(normalized);
	if (keywords.length > 0) return keywords;
	return normalized.split(/[^\p{L}\p{N}]+/u).map((token) => token.trim()).filter((token) => token.length > 0);
}
function hasAskOverlap(summary, latestAsk) {
	if (!latestAsk) return true;
	const askTokens = Array.from(new Set(tokenizeAskOverlapText(latestAsk))).slice(0, MAX_ASK_OVERLAP_TOKENS);
	if (askTokens.length === 0) return true;
	const meaningfulAskTokens = askTokens.filter((token) => {
		if (token.length <= 1) return false;
		if (isQueryStopWordToken(token)) return false;
		return true;
	});
	const tokensToCheck = meaningfulAskTokens.length > 0 ? meaningfulAskTokens : askTokens;
	if (tokensToCheck.length === 0) return true;
	const summaryTokens = new Set(tokenizeAskOverlapText(summary));
	let overlapCount = 0;
	for (const token of tokensToCheck) if (summaryTokens.has(token)) overlapCount += 1;
	const requiredMatches = tokensToCheck.length >= MIN_ASK_OVERLAP_TOKENS_FOR_DOUBLE_MATCH ? 2 : 1;
	return overlapCount >= requiredMatches;
}
function auditSummaryQuality(params) {
	const reasons = [];
	const lines = new Set(normalizedSummaryLines(params.summary));
	for (const section of REQUIRED_SUMMARY_SECTIONS) if (!lines.has(section)) reasons.push(`missing_section:${section}`);
	if ((params.identifierPolicy ?? "strict") === "strict") {
		const missingIdentifiers = params.identifiers.filter((identifier) => !summaryIncludesIdentifier(params.summary, identifier));
		if (missingIdentifiers.length > 0) reasons.push(`missing_identifiers:${missingIdentifiers.slice(0, 3).join(",")}`);
	}
	if (!hasAskOverlap(params.summary, params.latestAsk)) reasons.push("latest_user_ask_not_reflected");
	return {
		ok: reasons.length === 0,
		reasons
	};
}
//#endregion
//#region src/agents/pi-hooks/compaction-safeguard.ts
const log = createSubsystemLogger("compaction-safeguard");
const missedModelWarningSessions = /* @__PURE__ */ new WeakSet();
const TURN_PREFIX_INSTRUCTIONS = "This summary covers the prefix of a split turn. Focus on the original request, early progress, and any details needed to understand the retained suffix.";
const MAX_TOOL_FAILURES = 8;
const MAX_TOOL_FAILURE_CHARS = 240;
const MAX_COMPACTION_SUMMARY_CHARS = 16e3;
const MAX_FILE_OPS_SECTION_CHARS = 2e3;
const MAX_FILE_OPS_LIST_CHARS = 900;
const SUMMARY_TRUNCATED_MARKER = "\n\n[Compaction summary truncated to fit budget]";
const DEFAULT_RECENT_TURNS_PRESERVE = 3;
const DEFAULT_QUALITY_GUARD_MAX_RETRIES = 1;
const MAX_RECENT_TURNS_PRESERVE = 12;
const MAX_QUALITY_GUARD_MAX_RETRIES = 3;
const MAX_RECENT_TURN_TEXT_CHARS = 600;
const PREVIOUS_SUMMARY_REDISTILL_PREFIX = "Previous compaction summary to re-distill with the current conversation. Prune stale, duplicate, or superseded details instead of preserving it verbatim.";
const compactionSafeguardDeps = { summarizeInStages };
function buildPreviousSummaryMessage(previousSummary) {
	return {
		role: "user",
		content: [{
			type: "text",
			text: `<previous-compaction-summary>\n${PREVIOUS_SUMMARY_REDISTILL_PREFIX}\n\n${previousSummary.trim()}\n</previous-compaction-summary>`
		}],
		timestamp: 0
	};
}
function prependPreviousSummaryForRedistill(params) {
	const previousSummary = params.previousSummary?.trim();
	if (!previousSummary) return params.messages;
	return [buildPreviousSummaryMessage(previousSummary), ...params.messages];
}
/**
* Attempt provider-based summarization. Returns the summary string on success,
* or `undefined` when the caller should fall back to built-in LLM summarization.
* Rethrows abort/timeout errors so cancellation is always respected.
*/
async function tryProviderSummarize(provider, params) {
	try {
		const result = await provider.summarize(params);
		if (typeof result === "string" && result.trim()) return result;
		log.warn(`Compaction provider "${provider.id}" returned empty result, falling back to LLM.`);
		return;
	} catch (err) {
		if (isAbortError(err) || isTimeoutError(err)) throw err;
		log.warn(`Compaction provider "${provider.id}" failed, falling back to LLM: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
}
/**
* Summarize via the built-in LLM pipeline (summarizeInStages).
* Only called when no compaction provider is available or the provider failed.
*/
async function summarizeViaLLM(params) {
	const messages = prependPreviousSummaryForRedistill({
		messages: params.messages,
		previousSummary: params.previousSummary
	});
	return compactionSafeguardDeps.summarizeInStages({
		messages,
		model: params.model,
		apiKey: params.apiKey,
		headers: params.headers,
		signal: params.signal,
		reserveTokens: params.reserveTokens,
		maxChunkTokens: params.maxChunkTokens,
		contextWindow: params.contextWindow,
		customInstructions: params.customInstructions,
		summarizationInstructions: params.summarizationInstructions,
		previousSummary: void 0
	});
}
/**
* Build the reserved suffix that follows the summary body. Both the provider
* and LLM paths use this so diagnostic sections survive truncation.
*/
function assembleSuffix(parts) {
	let suffix = "";
	suffix = appendSummarySection(suffix, parts.splitTurnSection ?? "");
	suffix = appendSummarySection(suffix, parts.preservedTurnsSection ?? "");
	suffix = appendSummarySection(suffix, parts.toolFailureSection ?? "");
	suffix = appendSummarySection(suffix, parts.fileOpsSummary ?? "");
	suffix = appendSummarySection(suffix, parts.workspaceContext ?? "");
	if (suffix && !/^\s/.test(suffix)) suffix = `\n\n${suffix}`;
	return suffix;
}
/**
* Resolve model credentials. Returns auth details on success or a cancel reason on failure.
* Extracted to keep the main handler readable when model/auth is conditional.
*/
async function resolveModelAuth(ctx, model) {
	let requestAuth;
	try {
		const modelRegistry = ctx.modelRegistry;
		if (typeof modelRegistry.getApiKeyAndHeaders !== "function") throw new Error("model registry auth lookup unavailable");
		requestAuth = await modelRegistry.getApiKeyAndHeaders(model);
	} catch (err) {
		const error = formatErrorMessage(err);
		log.warn(`Compaction safeguard: request credentials unavailable; cancelling compaction. ${error}`);
		return {
			ok: false,
			reason: `Compaction safeguard could not resolve request credentials for ${model.provider}/${model.id}: ${error}`
		};
	}
	if (!requestAuth.ok) {
		log.warn(`Compaction safeguard: request credential resolution failed for ${model.provider}/${model.id}: ${requestAuth.error}`);
		return {
			ok: false,
			reason: `Compaction safeguard could not resolve request credentials for ${model.provider}/${model.id}: ${requestAuth.error}`
		};
	}
	if (!requestAuth.apiKey && !requestAuth.headers) {
		log.warn("Compaction safeguard: no request credentials available; cancelling compaction to preserve history.");
		return {
			ok: false,
			reason: `Compaction safeguard could not resolve request credentials for ${model.provider}/${model.id}.`
		};
	}
	const headers = model.provider === "github-copilot" ? {
		...buildCopilotIdeHeaders(),
		...requestAuth.headers
	} : requestAuth.headers;
	return {
		ok: true,
		apiKey: requestAuth.apiKey,
		headers
	};
}
function buildCompactionSummaryHeaders(params) {
	if (params.model.provider !== "github-copilot") return params.headers;
	const messages = params.messages;
	return {
		...buildCopilotDynamicHeaders({
			messages,
			hasImages: hasCopilotVisionInput(messages)
		}),
		...params.headers
	};
}
function clampNonNegativeInt(value, fallback) {
	return Math.max(0, Math.floor(typeof value === "number" && Number.isFinite(value) ? value : fallback));
}
function resolveRecentTurnsPreserve(value) {
	return Math.min(MAX_RECENT_TURNS_PRESERVE, clampNonNegativeInt(value, DEFAULT_RECENT_TURNS_PRESERVE));
}
function resolveQualityGuardMaxRetries(value) {
	return Math.min(MAX_QUALITY_GUARD_MAX_RETRIES, clampNonNegativeInt(value, DEFAULT_QUALITY_GUARD_MAX_RETRIES));
}
function normalizeFailureText(text) {
	return text.replace(/\s+/g, " ").trim();
}
function truncateFailureText(text, maxChars) {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}
function formatToolFailureMeta(details) {
	if (!details || typeof details !== "object") return;
	const record = details;
	const status = typeof record.status === "string" ? record.status : void 0;
	const exitCode = typeof record.exitCode === "number" && Number.isFinite(record.exitCode) ? record.exitCode : void 0;
	const parts = [];
	if (status) parts.push(`status=${status}`);
	if (exitCode !== void 0) parts.push(`exitCode=${exitCode}`);
	return parts.length > 0 ? parts.join(" ") : void 0;
}
function extractToolResultText(content) {
	return collectTextContentBlocks(content).join("\n");
}
function collectToolFailures(messages) {
	const failures = [];
	const seen = /* @__PURE__ */ new Set();
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		if (message.role !== "toolResult") continue;
		const toolResult = message;
		if (toolResult.isError !== true) continue;
		const toolCallId = typeof toolResult.toolCallId === "string" ? toolResult.toolCallId : "";
		if (!toolCallId || seen.has(toolCallId)) continue;
		seen.add(toolCallId);
		const toolName = typeof toolResult.toolName === "string" && toolResult.toolName.trim() ? toolResult.toolName : "tool";
		const rawText = extractToolResultText(toolResult.content);
		const meta = formatToolFailureMeta(toolResult.details);
		const summary = truncateFailureText(normalizeFailureText(rawText) || (meta ? "failed" : "failed (no output)"), MAX_TOOL_FAILURE_CHARS);
		failures.push({
			toolCallId,
			toolName,
			summary,
			meta
		});
	}
	return failures;
}
function formatToolFailuresSection(failures) {
	if (failures.length === 0) return "";
	const lines = failures.slice(0, MAX_TOOL_FAILURES).map((failure) => {
		const meta = failure.meta ? ` (${failure.meta})` : "";
		return `- ${failure.toolName}${meta}: ${failure.summary}`;
	});
	if (failures.length > MAX_TOOL_FAILURES) lines.push(`- ...and ${failures.length - MAX_TOOL_FAILURES} more`);
	return `\n\n## Tool Failures\n${lines.join("\n")}`;
}
function computeFileLists(fileOps) {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	return {
		readFiles: [...fileOps.read].filter((f) => !modified.has(f)).toSorted(),
		modifiedFiles: [...modified].toSorted()
	};
}
function formatFileOperations(readFiles, modifiedFiles) {
	function formatBoundedFileList(tag, files, maxChars) {
		if (files.length === 0 || maxChars <= 0) return "";
		const openTag = `<${tag}>\n`;
		const closeTag = `\n</${tag}>`;
		const lines = [];
		let usedChars = openTag.length + closeTag.length;
		for (let i = 0; i < files.length; i++) {
			const line = `${files[i]}\n`;
			const remaining = files.length - i - 1;
			const overflowLine = remaining > 0 ? `...and ${remaining} more\n` : "";
			if (usedChars + line.length + overflowLine.length > maxChars) {
				const overflow = `...and ${files.length - i} more\n`;
				if (usedChars + overflow.length <= maxChars) lines.push(overflow);
				break;
			}
			lines.push(line);
			usedChars += line.length;
		}
		return lines.length > 0 ? `${openTag}${lines.join("")}${closeTag}` : "";
	}
	const sections = [];
	const readSection = formatBoundedFileList("read-files", readFiles, MAX_FILE_OPS_LIST_CHARS);
	const modifiedSection = formatBoundedFileList("modified-files", modifiedFiles, MAX_FILE_OPS_LIST_CHARS);
	if (readSection) sections.push(readSection);
	if (modifiedSection) sections.push(modifiedSection);
	if (sections.length === 0) return "";
	return capCompactionSummary(`\n\n${sections.join("\n\n")}`, MAX_FILE_OPS_SECTION_CHARS);
}
function capCompactionSummary(summary, maxChars = MAX_COMPACTION_SUMMARY_CHARS) {
	if (maxChars <= 0 || summary.length <= maxChars) return summary;
	const marker = SUMMARY_TRUNCATED_MARKER;
	const budget = Math.max(0, maxChars - 46);
	if (budget <= 0) return summary.slice(0, maxChars);
	return `${summary.slice(0, budget)}${marker}`;
}
function capCompactionSummaryPreservingSuffix(summaryBody, suffix, maxChars = MAX_COMPACTION_SUMMARY_CHARS) {
	if (!suffix) return capCompactionSummary(summaryBody, maxChars);
	if (maxChars <= 0) return capCompactionSummary(`${summaryBody}${suffix}`, maxChars);
	if (suffix.length >= maxChars) return suffix.slice(-maxChars);
	return `${capCompactionSummary(summaryBody, Math.max(0, maxChars - suffix.length))}${suffix}`;
}
function extractMessageText(message) {
	const content = message.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const text = block.text;
		if (typeof text === "string" && text.trim().length > 0) parts.push(text.trim());
	}
	return parts.join("\n").trim();
}
function formatNonTextPlaceholder(content) {
	if (content === null || content === void 0) return null;
	if (typeof content === "string") return null;
	if (!Array.isArray(content)) return "[non-text content]";
	const typeCounts = /* @__PURE__ */ new Map();
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const typeRaw = block.type;
		const type = typeof typeRaw === "string" && typeRaw.trim().length > 0 ? typeRaw : "unknown";
		if (type === "text") continue;
		typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
	}
	if (typeCounts.size === 0) return null;
	return `[non-text content: ${[...typeCounts.entries()].map(([type, count]) => count > 1 ? `${type} x${count}` : type).join(", ")}]`;
}
function splitPreservedRecentTurns(params) {
	const preserveTurns = Math.min(MAX_RECENT_TURNS_PRESERVE, clampNonNegativeInt(params.recentTurnsPreserve, 0));
	if (preserveTurns <= 0) return {
		summarizableMessages: params.messages,
		preservedMessages: []
	};
	const conversationIndexes = [];
	const userIndexes = [];
	for (let i = 0; i < params.messages.length; i += 1) {
		const role = params.messages[i].role;
		if (role === "user" || role === "assistant") {
			conversationIndexes.push(i);
			if (role === "user") userIndexes.push(i);
		}
	}
	if (conversationIndexes.length === 0) return {
		summarizableMessages: params.messages,
		preservedMessages: []
	};
	const preservedIndexSet = /* @__PURE__ */ new Set();
	if (userIndexes.length >= preserveTurns) {
		const boundaryStartIndex = userIndexes[userIndexes.length - preserveTurns] ?? -1;
		if (boundaryStartIndex >= 0) {
			for (const index of conversationIndexes) if (index >= boundaryStartIndex) preservedIndexSet.add(index);
		}
	} else {
		const fallbackMessageCount = preserveTurns * 2;
		for (const userIndex of userIndexes) preservedIndexSet.add(userIndex);
		for (let i = conversationIndexes.length - 1; i >= 0; i -= 1) {
			const index = conversationIndexes[i];
			if (index === void 0) continue;
			preservedIndexSet.add(index);
			if (preservedIndexSet.size >= fallbackMessageCount) break;
		}
	}
	if (preservedIndexSet.size === 0) return {
		summarizableMessages: params.messages,
		preservedMessages: []
	};
	const preservedToolCallIds = /* @__PURE__ */ new Set();
	for (let i = 0; i < params.messages.length; i += 1) {
		if (!preservedIndexSet.has(i)) continue;
		const message = params.messages[i];
		if (message.role !== "assistant") continue;
		const toolCalls = extractToolCallsFromAssistant(message);
		for (const toolCall of toolCalls) preservedToolCallIds.add(toolCall.id);
	}
	if (preservedToolCallIds.size > 0) {
		let preservedStartIndex = -1;
		for (let i = 0; i < params.messages.length; i += 1) if (preservedIndexSet.has(i)) {
			preservedStartIndex = i;
			break;
		}
		if (preservedStartIndex >= 0) for (let i = preservedStartIndex; i < params.messages.length; i += 1) {
			const message = params.messages[i];
			if (message.role !== "toolResult") continue;
			const toolResultId = extractToolResultId(message);
			if (toolResultId && preservedToolCallIds.has(toolResultId)) preservedIndexSet.add(i);
		}
	}
	return {
		summarizableMessages: repairToolUseResultPairing(params.messages.filter((_, idx) => !preservedIndexSet.has(idx))).messages,
		preservedMessages: params.messages.filter((_, idx) => preservedIndexSet.has(idx)).filter((msg) => {
			const role = msg.role;
			return role === "user" || role === "assistant" || role === "toolResult";
		})
	};
}
function formatContextMessages(messages) {
	return messages.map((message) => {
		let roleLabel;
		if (message.role === "assistant") roleLabel = "Assistant";
		else if (message.role === "user") roleLabel = "User";
		else if (message.role === "toolResult") {
			const toolName = message.toolName;
			roleLabel = `Tool result (${typeof toolName === "string" && toolName.trim() ? toolName : "tool"})`;
		} else return null;
		const text = extractMessageText(message);
		const nonTextPlaceholder = formatNonTextPlaceholder(message.content);
		const rendered = text && nonTextPlaceholder ? `${text}\n${nonTextPlaceholder}` : text || nonTextPlaceholder;
		if (!rendered) return null;
		const trimmed = rendered.length > MAX_RECENT_TURN_TEXT_CHARS ? `${rendered.slice(0, MAX_RECENT_TURN_TEXT_CHARS)}...` : rendered;
		return `- ${roleLabel}: ${trimmed}`;
	}).filter((line) => Boolean(line));
}
function formatPreservedTurnsSection(messages) {
	if (messages.length === 0) return "";
	const lines = formatContextMessages(messages);
	if (lines.length === 0) return "";
	return `\n\n## Recent turns preserved verbatim\n${lines.join("\n")}`;
}
function formatSplitTurnContextSection(messages) {
	if (messages.length === 0) return "";
	const lines = formatContextMessages(messages);
	if (lines.length === 0) return "";
	return `**Turn Context (split turn):**\n\n${lines.join("\n")}`;
}
function extractLatestUserAsk(messages) {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message.role !== "user") continue;
		const text = extractMessageText(message);
		if (text) return text;
	}
	return null;
}
/**
* Read and format critical workspace context for compaction summary.
* Extracts "Session Startup" and "Red Lines" from AGENTS.md.
* Falls back to legacy names "Every Session" and "Safety".
* Limited to 2000 chars to avoid bloating the summary.
*/
async function readWorkspaceContextForSummary() {
	const MAX_SUMMARY_CONTEXT_CHARS = 2e3;
	const workspaceDir = process.cwd();
	const agentsPath = path.join(workspaceDir, "AGENTS.md");
	try {
		const opened = await openBoundaryFile({
			absolutePath: agentsPath,
			rootPath: workspaceDir,
			boundaryLabel: "workspace root"
		});
		if (!opened.ok) return "";
		const content = (() => {
			try {
				return fs.readFileSync(opened.fd, "utf-8");
			} finally {
				fs.closeSync(opened.fd);
			}
		})();
		let sections = extractSections(content, ["Session Startup", "Red Lines"]);
		if (sections.length === 0) sections = extractSections(content, ["Every Session", "Safety"]);
		if (sections.length === 0) return "";
		const combined = sections.join("\n\n");
		return `\n\n<workspace-critical-rules>\n${combined.length > MAX_SUMMARY_CONTEXT_CHARS ? combined.slice(0, MAX_SUMMARY_CONTEXT_CHARS) + "\n...[truncated]..." : combined}\n</workspace-critical-rules>`;
	} catch {
		return "";
	}
}
function compactionSafeguardExtension(api) {
	api.on("session_before_compact", async (event, ctx) => {
		const { preparation, customInstructions: eventInstructions, signal } = event;
		const rawTurnPrefixMessages = preparation.turnPrefixMessages ?? [];
		const baseMessagesToSummarize = stripRuntimeContextCustomMessages(preparation.messagesToSummarize);
		const baseTurnPrefixMessages = stripRuntimeContextCustomMessages(rawTurnPrefixMessages);
		const hasRealSummarizable = baseMessagesToSummarize.some((message, index, messages) => isRealConversationMessage(message, messages, index));
		const hasRealTurnPrefix = baseTurnPrefixMessages.some((message, index, messages) => isRealConversationMessage(message, messages, index));
		setCompactionSafeguardCancelReason(ctx.sessionManager, void 0);
		if (!hasRealSummarizable && !hasRealTurnPrefix) {
			log.info("Compaction safeguard: no real conversation messages to summarize; writing compaction boundary to suppress re-trigger loop.");
			return { compaction: {
				summary: buildStructuredFallbackSummary(preparation.previousSummary),
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore
			} };
		}
		const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
		const fileOpsSummary = formatFileOperations(readFiles, modifiedFiles);
		const toolFailureSection = formatToolFailuresSection(collectToolFailures([...baseMessagesToSummarize, ...baseTurnPrefixMessages]));
		const runtime = getCompactionSafeguardRuntime(ctx.sessionManager);
		const customInstructions = resolveCompactionInstructions(eventInstructions, runtime?.customInstructions);
		const summarizationInstructions = {
			identifierPolicy: runtime?.identifierPolicy,
			identifierInstructions: runtime?.identifierInstructions
		};
		const identifierPolicy = runtime?.identifierPolicy ?? "strict";
		const providerId = runtime?.provider;
		const turnPrefixMessages = baseTurnPrefixMessages;
		const recentTurnsPreserve = resolveRecentTurnsPreserve(runtime?.recentTurnsPreserve);
		const { preservedMessages: providerPreservedMessages } = splitPreservedRecentTurns({
			messages: baseMessagesToSummarize,
			recentTurnsPreserve
		});
		const preservedTurnsSection = formatPreservedTurnsSection(providerPreservedMessages);
		const splitTurnSection = preparation.isSplitTurn ? formatSplitTurnContextSection(turnPrefixMessages) : "";
		const structuredInstructions = buildCompactionStructureInstructions(customInstructions, summarizationInstructions);
		if (providerId) {
			const compactionProvider = getCompactionProvider(providerId);
			if (compactionProvider) try {
				const providerResult = await tryProviderSummarize(compactionProvider, {
					messages: [...baseMessagesToSummarize, ...turnPrefixMessages],
					signal,
					customInstructions: structuredInstructions,
					summarizationInstructions,
					previousSummary: preparation.previousSummary
				});
				if (providerResult !== void 0) return { compaction: {
					summary: capCompactionSummaryPreservingSuffix(providerResult, assembleSuffix({
						splitTurnSection,
						preservedTurnsSection,
						toolFailureSection,
						fileOpsSummary,
						workspaceContext: await readWorkspaceContextForSummary()
					})),
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details: {
						readFiles,
						modifiedFiles
					}
				} };
				log.info("Compaction provider did not produce a result; falling back to LLM path.");
			} catch (err) {
				if (isAbortError(err) || isTimeoutError(err)) throw err;
				log.warn(`Compaction provider path failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
			}
			else log.warn(`Compaction provider "${providerId}" is configured but not registered. Falling back to LLM.`);
		}
		const model = ctx.model ?? runtime?.model;
		if (!model) {
			if (!ctx.model && !runtime?.model && !missedModelWarningSessions.has(ctx.sessionManager)) {
				missedModelWarningSessions.add(ctx.sessionManager);
				log.warn("[compaction-safeguard] Both ctx.model and runtime.model are undefined. Compaction summarization will not run. This indicates extensionRunner.initialize() was not called and model was not passed through runtime registry.");
			}
			setCompactionSafeguardCancelReason(ctx.sessionManager, "Compaction safeguard could not resolve a summarization model.");
			return { cancel: true };
		}
		const authResult = await resolveModelAuth(ctx, model);
		if (!authResult.ok) {
			setCompactionSafeguardCancelReason(ctx.sessionManager, authResult.reason);
			return { cancel: true };
		}
		const apiKey = authResult.apiKey ?? "";
		const authHeaders = authResult.headers;
		try {
			const modelContextWindow = resolveContextWindowTokens$1(model);
			const contextWindowTokens = runtime?.contextWindowTokens ?? modelContextWindow;
			let messagesToSummarize = baseMessagesToSummarize;
			const headers = buildCompactionSummaryHeaders({
				model,
				messages: messagesToSummarize,
				headers: authHeaders
			});
			const qualityGuardEnabled = runtime?.qualityGuardEnabled ?? false;
			const qualityGuardMaxRetries = resolveQualityGuardMaxRetries(runtime?.qualityGuardMaxRetries);
			const maxHistoryShare = runtime?.maxHistoryShare ?? .5;
			const tokensBefore = typeof preparation.tokensBefore === "number" && Number.isFinite(preparation.tokensBefore) ? preparation.tokensBefore : void 0;
			let droppedSummary;
			if (tokensBefore !== void 0) {
				const summarizableTokens = estimateMessagesTokens(messagesToSummarize) + estimateMessagesTokens(turnPrefixMessages);
				const newContentTokens = Math.max(0, Math.floor(tokensBefore - summarizableTokens));
				if (newContentTokens > Math.floor(contextWindowTokens * maxHistoryShare * 1.2)) {
					const pruned = pruneHistoryForContextShare({
						messages: messagesToSummarize,
						maxContextTokens: contextWindowTokens,
						maxHistoryShare,
						parts: 2
					});
					if (pruned.droppedChunks > 0) {
						const newContentRatio = newContentTokens / contextWindowTokens * 100;
						log.warn(`Compaction safeguard: new content uses ${newContentRatio.toFixed(1)}% of context; dropped ${pruned.droppedChunks} older chunk(s) (${pruned.droppedMessages} messages) to fit history budget.`);
						messagesToSummarize = pruned.messages;
						if (pruned.droppedMessagesList.length > 0) try {
							const droppedChunkRatio = computeAdaptiveChunkRatio(pruned.droppedMessagesList, contextWindowTokens);
							const droppedMaxChunkTokens = Math.max(1, Math.floor(contextWindowTokens * droppedChunkRatio) - SUMMARIZATION_OVERHEAD_TOKENS);
							droppedSummary = await summarizeViaLLM({
								messages: pruned.droppedMessagesList,
								model,
								apiKey,
								headers,
								signal,
								reserveTokens: Math.max(1, Math.floor(preparation.settings.reserveTokens)),
								maxChunkTokens: droppedMaxChunkTokens,
								contextWindow: contextWindowTokens,
								customInstructions: structuredInstructions,
								summarizationInstructions,
								previousSummary: preparation.previousSummary
							});
						} catch (droppedError) {
							log.warn(`Compaction safeguard: failed to summarize dropped messages, continuing without: ${formatErrorMessage(droppedError)}`);
						}
					}
				}
			}
			const { summarizableMessages: summaryTargetMessages, preservedMessages: preservedRecentMessages } = splitPreservedRecentTurns({
				messages: messagesToSummarize,
				recentTurnsPreserve
			});
			messagesToSummarize = summaryTargetMessages;
			const preservedTurnsSection = formatPreservedTurnsSection(preservedRecentMessages);
			const latestUserAsk = extractLatestUserAsk([...messagesToSummarize, ...turnPrefixMessages]);
			const identifiers = extractOpaqueIdentifiers([...messagesToSummarize, ...turnPrefixMessages].slice(-10).map((message) => extractMessageText(message)).filter(Boolean).join("\n"));
			const adaptiveRatio = computeAdaptiveChunkRatio([...messagesToSummarize, ...turnPrefixMessages], contextWindowTokens);
			const maxChunkTokens = Math.max(1, Math.floor(contextWindowTokens * adaptiveRatio) - SUMMARIZATION_OVERHEAD_TOKENS);
			const reserveTokens = Math.max(1, Math.floor(preparation.settings.reserveTokens));
			const effectivePreviousSummary = droppedSummary ?? preparation.previousSummary;
			let summary = "";
			let lastHistorySummary = "";
			let lastSplitTurnSection = "";
			let currentInstructions = structuredInstructions;
			const totalAttempts = qualityGuardEnabled ? qualityGuardMaxRetries + 1 : 1;
			let lastSuccessfulSummary = null;
			for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
				let summaryWithoutPreservedTurns = "";
				let summaryWithPreservedTurns = "";
				let splitTurnSection = "";
				let historySummary = "";
				try {
					historySummary = messagesToSummarize.length > 0 ? await summarizeViaLLM({
						messages: messagesToSummarize,
						model,
						apiKey,
						headers,
						signal,
						reserveTokens,
						maxChunkTokens,
						contextWindow: contextWindowTokens,
						customInstructions: currentInstructions,
						summarizationInstructions,
						previousSummary: effectivePreviousSummary
					}) : buildStructuredFallbackSummary(effectivePreviousSummary, summarizationInstructions);
					summaryWithoutPreservedTurns = historySummary;
					if (preparation.isSplitTurn && turnPrefixMessages.length > 0) {
						splitTurnSection = `**Turn Context (split turn):**\n\n${await summarizeViaLLM({
							messages: turnPrefixMessages,
							model,
							apiKey,
							headers,
							signal,
							reserveTokens,
							maxChunkTokens,
							contextWindow: contextWindowTokens,
							customInstructions: composeSplitTurnInstructions(TURN_PREFIX_INSTRUCTIONS, currentInstructions),
							summarizationInstructions,
							previousSummary: void 0
						})}`;
						summaryWithoutPreservedTurns = historySummary.trim() ? `${historySummary}\n\n---\n\n${splitTurnSection}` : splitTurnSection;
					}
					summaryWithPreservedTurns = appendSummarySection(summaryWithoutPreservedTurns, preservedTurnsSection);
				} catch (attemptError) {
					if (lastSuccessfulSummary && attempt > 0) {
						log.warn(`Compaction safeguard: quality retry failed on attempt ${attempt + 1}; keeping last successful summary: ${formatErrorMessage(attemptError)}`);
						summary = lastSuccessfulSummary;
						break;
					}
					throw attemptError;
				}
				lastSuccessfulSummary = summaryWithPreservedTurns;
				lastHistorySummary = historySummary;
				lastSplitTurnSection = splitTurnSection;
				const canRegenerate = messagesToSummarize.length > 0 || preparation.isSplitTurn && turnPrefixMessages.length > 0;
				if (!qualityGuardEnabled || !canRegenerate) {
					summary = summaryWithPreservedTurns;
					break;
				}
				const quality = auditSummaryQuality({
					summary: summaryWithoutPreservedTurns,
					identifiers,
					latestAsk: latestUserAsk,
					identifierPolicy
				});
				summary = summaryWithPreservedTurns;
				if (quality.ok || attempt >= totalAttempts - 1) break;
				const reasons = quality.reasons.join(", ");
				const qualityFeedbackInstruction = identifierPolicy === "strict" ? "Fix all issues and include every required section with exact identifiers preserved." : "Fix all issues and include every required section while following the configured identifier policy.";
				const qualityFeedbackReasons = wrapUntrustedInstructionBlock("Quality check feedback", `Previous summary failed quality checks (${reasons}).`);
				currentInstructions = qualityFeedbackReasons ? `${structuredInstructions}\n\n${qualityFeedbackInstruction}\n\n${qualityFeedbackReasons}` : `${structuredInstructions}\n\n${qualityFeedbackInstruction}`;
			}
			const workspaceContext = await readWorkspaceContextForSummary();
			const suffix = assembleSuffix({
				splitTurnSection: lastSplitTurnSection,
				preservedTurnsSection,
				toolFailureSection,
				fileOpsSummary,
				workspaceContext
			});
			summary = capCompactionSummaryPreservingSuffix(lastHistorySummary || summary, suffix);
			return { compaction: {
				summary,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {
					readFiles,
					modifiedFiles
				}
			} };
		} catch (error) {
			const message = formatErrorMessage(error);
			log.warn(`Compaction summarization failed; cancelling compaction to preserve history: ${message}`);
			setCompactionSafeguardCancelReason(ctx.sessionManager, `Compaction safeguard could not summarize the session: ${message}`);
			return { cancel: true };
		}
	});
}
//#endregion
//#region src/agents/pi-hooks/context-pruning/tools.ts
function normalizeGlob(value) {
	return normalizeLowercaseStringOrEmpty(value ?? "");
}
function makeToolPrunablePredicate(match) {
	const deny = compileGlobPatterns({
		raw: match.deny,
		normalize: normalizeGlob
	});
	const allow = compileGlobPatterns({
		raw: match.allow,
		normalize: normalizeGlob
	});
	return (toolName) => {
		const normalized = normalizeGlob(toolName);
		if (matchesAnyGlobPattern(normalized, deny)) return false;
		if (allow.length === 0) return true;
		return matchesAnyGlobPattern(normalized, allow);
	};
}
//#endregion
//#region src/agents/pi-hooks/context-pruning/pruner.ts
const IMAGE_CHAR_ESTIMATE = 8e3;
const PRUNED_CONTEXT_IMAGE_MARKER = "[image removed during context pruning]";
function asText(text) {
	return {
		type: "text",
		text
	};
}
function serializeMalformedTextBlock(block) {
	try {
		const serialized = JSON.stringify(block);
		return typeof serialized === "string" ? serialized : "[malformed text block]";
	} catch {
		return "[malformed text block]";
	}
}
function coerceTextBlock(block) {
	if (!block || typeof block !== "object") return null;
	if (block.type !== "text") return null;
	const text = block.text;
	return typeof text === "string" ? text : serializeMalformedTextBlock(block);
}
function isImageBlock(block) {
	return !!block && typeof block === "object" && block.type === "image";
}
function collectTextSegments(content) {
	const parts = [];
	for (const block of content) {
		const text = coerceTextBlock(block);
		if (text !== null) parts.push(text);
	}
	return parts;
}
function collectPrunableToolResultSegments(content) {
	const parts = [];
	for (const block of content) {
		const text = coerceTextBlock(block);
		if (text !== null) {
			parts.push(text);
			continue;
		}
		if (isImageBlock(block)) parts.push(PRUNED_CONTEXT_IMAGE_MARKER);
	}
	return parts;
}
function estimateJoinedTextLength(parts) {
	if (parts.length === 0) return 0;
	let len = 0;
	for (const p of parts) len += p.length;
	len += Math.max(0, parts.length - 1);
	return len;
}
function takeHeadFromJoinedText(parts, maxChars) {
	if (maxChars <= 0 || parts.length === 0) return "";
	let remaining = maxChars;
	let out = "";
	for (let i = 0; i < parts.length && remaining > 0; i++) {
		if (i > 0) {
			out += "\n";
			remaining -= 1;
			if (remaining <= 0) break;
		}
		const p = parts[i];
		if (p.length <= remaining) {
			out += p;
			remaining -= p.length;
		} else {
			out += p.slice(0, remaining);
			remaining = 0;
		}
	}
	return out;
}
function takeTailFromJoinedText(parts, maxChars) {
	if (maxChars <= 0 || parts.length === 0) return "";
	let remaining = maxChars;
	const out = [];
	for (let i = parts.length - 1; i >= 0 && remaining > 0; i--) {
		const p = parts[i];
		if (p.length <= remaining) {
			out.push(p);
			remaining -= p.length;
		} else {
			out.push(p.slice(p.length - remaining));
			remaining = 0;
			break;
		}
		if (remaining > 0 && i > 0) {
			out.push("\n");
			remaining -= 1;
		}
	}
	out.reverse();
	return out.join("");
}
function hasImageBlocks(content) {
	for (const block of content) if (isImageBlock(block)) return true;
	return false;
}
function estimateWeightedTextChars(text) {
	return estimateStringChars(text);
}
function estimateTextAndImageChars(content) {
	let chars = 0;
	for (const block of content) {
		const text = coerceTextBlock(block);
		if (text !== null) {
			chars += estimateWeightedTextChars(text);
			continue;
		}
		if (isImageBlock(block)) chars += IMAGE_CHAR_ESTIMATE;
	}
	return chars;
}
function estimateMessageChars(message) {
	if (message.role === "user") {
		const content = message.content;
		if (typeof content === "string") return estimateWeightedTextChars(content);
		return estimateTextAndImageChars(content);
	}
	if (message.role === "assistant") {
		let chars = 0;
		for (const b of message.content) {
			if (!b || typeof b !== "object") continue;
			if (b.type === "text" && typeof b.text === "string") chars += estimateWeightedTextChars(b.text);
			const blockType = b.type;
			if (blockType === "thinking" || blockType === "redacted_thinking") {
				const thinking = b.thinking;
				if (typeof thinking === "string") chars += estimateWeightedTextChars(thinking);
				const data = b.data;
				if (blockType === "redacted_thinking" && typeof data === "string") chars += estimateWeightedTextChars(data);
				const signature = b.thinkingSignature;
				if (typeof signature === "string") chars += estimateWeightedTextChars(signature);
			}
			if (b.type === "toolCall") try {
				chars += JSON.stringify(b.arguments ?? {}).length;
			} catch {
				chars += 128;
			}
		}
		return chars;
	}
	if (message.role === "toolResult") return estimateTextAndImageChars(message.content);
	return 256;
}
function estimateContextChars(messages) {
	return messages.reduce((sum, m) => sum + estimateMessageChars(m), 0);
}
function findAssistantCutoffIndex(messages, keepLastAssistants) {
	if (keepLastAssistants <= 0) return messages.length;
	let remaining = keepLastAssistants;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role !== "assistant") continue;
		remaining--;
		if (remaining === 0) return i;
	}
	return null;
}
function findFirstUserIndex(messages) {
	for (let i = 0; i < messages.length; i++) if (messages[i]?.role === "user") return i;
	return null;
}
function softTrimToolResultMessage(params) {
	const { msg, settings } = params;
	const hasImages = hasImageBlocks(msg.content);
	const parts = hasImages ? collectPrunableToolResultSegments(msg.content) : collectTextSegments(msg.content);
	const rawLen = estimateJoinedTextLength(parts);
	if (rawLen <= settings.softTrim.maxChars) {
		if (!hasImages) return null;
		return {
			...msg,
			content: [asText(parts.join("\n"))]
		};
	}
	const headChars = Math.max(0, settings.softTrim.headChars);
	const tailChars = Math.max(0, settings.softTrim.tailChars);
	if (headChars + tailChars >= rawLen) {
		if (!hasImages) return null;
		return {
			...msg,
			content: [asText(parts.join("\n"))]
		};
	}
	const trimmed = `${takeHeadFromJoinedText(parts, headChars)}
...
${takeTailFromJoinedText(parts, tailChars)}`;
	const note = `

[Tool result trimmed: kept first ${headChars} chars and last ${tailChars} chars of ${rawLen} chars.]`;
	return {
		...msg,
		content: [asText(trimmed + note)]
	};
}
function pruneContextMessages(params) {
	const { messages, settings, ctx } = params;
	const contextWindowTokens = typeof params.contextWindowTokensOverride === "number" && Number.isFinite(params.contextWindowTokensOverride) && params.contextWindowTokensOverride > 0 ? params.contextWindowTokensOverride : ctx.model?.contextWindow;
	if (!contextWindowTokens || contextWindowTokens <= 0) return messages;
	const charWindow = contextWindowTokens * 4;
	if (charWindow <= 0) return messages;
	const cutoffIndex = findAssistantCutoffIndex(messages, settings.keepLastAssistants);
	if (cutoffIndex === null) return messages;
	const firstUserIndex = findFirstUserIndex(messages);
	const pruneStartIndex = firstUserIndex === null ? messages.length : firstUserIndex;
	const isToolPrunable = params.isToolPrunable ?? makeToolPrunablePredicate(settings.tools);
	let totalChars = estimateContextChars(params.dropThinkingBlocksForEstimate ? dropThinkingBlocks(messages) : messages);
	let ratio = totalChars / charWindow;
	if (ratio < settings.softTrimRatio) return messages;
	const prunableToolIndexes = [];
	let next = null;
	for (let i = pruneStartIndex; i < cutoffIndex; i++) {
		const msg = messages[i];
		if (!msg || msg.role !== "toolResult") continue;
		if (!isToolPrunable(msg.toolName)) continue;
		prunableToolIndexes.push(i);
		const updated = softTrimToolResultMessage({
			msg,
			settings
		});
		if (!updated) continue;
		const beforeChars = estimateMessageChars(msg);
		const afterChars = estimateMessageChars(updated);
		totalChars += afterChars - beforeChars;
		if (!next) next = messages.slice();
		next[i] = updated;
	}
	const outputAfterSoftTrim = next ?? messages;
	ratio = totalChars / charWindow;
	if (ratio < settings.hardClearRatio) return outputAfterSoftTrim;
	if (!settings.hardClear.enabled) return outputAfterSoftTrim;
	let prunableToolChars = 0;
	for (const i of prunableToolIndexes) {
		const msg = outputAfterSoftTrim[i];
		if (!msg || msg.role !== "toolResult") continue;
		prunableToolChars += estimateMessageChars(msg);
	}
	if (prunableToolChars < settings.minPrunableToolChars) return outputAfterSoftTrim;
	for (const i of prunableToolIndexes) {
		if (ratio < settings.hardClearRatio) break;
		const msg = (next ?? messages)[i];
		if (!msg || msg.role !== "toolResult") continue;
		const beforeChars = estimateMessageChars(msg);
		const cleared = {
			...msg,
			content: [asText(settings.hardClear.placeholder)]
		};
		if (!next) next = messages.slice();
		next[i] = cleared;
		const afterChars = estimateMessageChars(cleared);
		totalChars += afterChars - beforeChars;
		ratio = totalChars / charWindow;
	}
	return next ?? messages;
}
//#endregion
//#region src/agents/pi-hooks/context-pruning/runtime.ts
const registry = createSessionManagerRuntimeRegistry();
const setContextPruningRuntime = registry.set;
const getContextPruningRuntime = registry.get;
//#endregion
//#region src/agents/pi-hooks/context-pruning/extension.ts
function contextPruningExtension(api) {
	api.on("context", (event, ctx) => {
		const runtime = getContextPruningRuntime(ctx.sessionManager);
		if (!runtime) return;
		if (runtime.settings.mode === "cache-ttl") {
			const ttlMs = runtime.settings.ttlMs;
			const lastTouch = runtime.lastCacheTouchAt ?? null;
			if (!lastTouch || ttlMs <= 0) return;
			if (ttlMs > 0 && Date.now() - lastTouch < ttlMs) return;
		}
		const next = pruneContextMessages({
			messages: event.messages,
			settings: runtime.settings,
			ctx,
			isToolPrunable: runtime.isToolPrunable,
			contextWindowTokensOverride: runtime.contextWindowTokens ?? void 0,
			dropThinkingBlocksForEstimate: runtime.dropThinkingBlocks
		});
		if (next === event.messages) return;
		if (runtime.settings.mode === "cache-ttl") runtime.lastCacheTouchAt = Date.now();
		return { messages: next };
	});
}
//#endregion
//#region src/agents/pi-hooks/context-pruning/settings.ts
const DEFAULT_CONTEXT_PRUNING_SETTINGS = {
	mode: "cache-ttl",
	ttlMs: 300 * 1e3,
	keepLastAssistants: 3,
	softTrimRatio: .3,
	hardClearRatio: .5,
	minPrunableToolChars: 5e4,
	tools: {},
	softTrim: {
		maxChars: 4e3,
		headChars: 1500,
		tailChars: 1500
	},
	hardClear: {
		enabled: true,
		placeholder: "[Old tool result content cleared]"
	}
};
function computeEffectiveSettings(raw) {
	if (!raw || typeof raw !== "object") return null;
	const cfg = raw;
	if (cfg.mode !== "cache-ttl") return null;
	const s = structuredClone(DEFAULT_CONTEXT_PRUNING_SETTINGS);
	s.mode = cfg.mode;
	if (typeof cfg.ttl === "string") try {
		s.ttlMs = parseDurationMs(cfg.ttl, { defaultUnit: "m" });
	} catch {}
	if (typeof cfg.keepLastAssistants === "number" && Number.isFinite(cfg.keepLastAssistants)) s.keepLastAssistants = Math.max(0, Math.floor(cfg.keepLastAssistants));
	if (typeof cfg.softTrimRatio === "number" && Number.isFinite(cfg.softTrimRatio)) s.softTrimRatio = Math.min(1, Math.max(0, cfg.softTrimRatio));
	if (typeof cfg.hardClearRatio === "number" && Number.isFinite(cfg.hardClearRatio)) s.hardClearRatio = Math.min(1, Math.max(0, cfg.hardClearRatio));
	if (typeof cfg.minPrunableToolChars === "number" && Number.isFinite(cfg.minPrunableToolChars)) s.minPrunableToolChars = Math.max(0, Math.floor(cfg.minPrunableToolChars));
	if (cfg.tools) s.tools = cfg.tools;
	if (cfg.softTrim) {
		if (typeof cfg.softTrim.maxChars === "number" && Number.isFinite(cfg.softTrim.maxChars)) s.softTrim.maxChars = Math.max(0, Math.floor(cfg.softTrim.maxChars));
		if (typeof cfg.softTrim.headChars === "number" && Number.isFinite(cfg.softTrim.headChars)) s.softTrim.headChars = Math.max(0, Math.floor(cfg.softTrim.headChars));
		if (typeof cfg.softTrim.tailChars === "number" && Number.isFinite(cfg.softTrim.tailChars)) s.softTrim.tailChars = Math.max(0, Math.floor(cfg.softTrim.tailChars));
	}
	if (cfg.hardClear) {
		if (typeof cfg.hardClear.enabled === "boolean") s.hardClear.enabled = cfg.hardClear.enabled;
		if (typeof cfg.hardClear.placeholder === "string" && cfg.hardClear.placeholder.trim()) s.hardClear.placeholder = cfg.hardClear.placeholder.trim();
	}
	return s;
}
//#endregion
//#region src/agents/pi-embedded-runner/extensions.ts
function recordFromUnknown(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function buildAgentToolResultMiddlewareFactory() {
	const runner = createAgentToolResultMiddlewareRunner({ runtime: "pi" });
	return (pi) => {
		pi.on("tool_result", async (rawEvent, ctx) => {
			const event = recordFromUnknown(rawEvent);
			if (!event.toolName) return;
			const toolCallId = typeof event.toolCallId === "string" && event.toolCallId.trim() ? event.toolCallId : `pi-${randomUUID()}`;
			const current = {
				content: Array.isArray(event.content) ? event.content : [],
				details: event.details
			};
			const result = await runner.applyToolResultMiddleware({
				threadId: event.threadId,
				turnId: event.turnId,
				toolCallId,
				toolName: event.toolName,
				args: recordFromUnknown(event.input),
				cwd: ctx.cwd,
				isError: event.isError,
				result: current
			});
			return {
				content: result.content,
				details: result.details
			};
		});
	};
}
function resolveContextWindowTokens(params) {
	return resolveContextWindowInfo({
		cfg: params.cfg,
		provider: params.provider,
		modelId: params.modelId,
		modelContextTokens: params.model?.contextTokens,
		modelContextWindow: params.model?.contextWindow,
		defaultTokens: DEFAULT_CONTEXT_TOKENS
	}).tokens;
}
function buildContextPruningFactory(params) {
	const raw = params.cfg?.agents?.defaults?.contextPruning;
	if (raw?.mode !== "cache-ttl") return;
	if (!isCacheTtlEligibleProvider(params.provider, params.modelId, params.model?.api)) return;
	const settings = computeEffectiveSettings(raw);
	if (!settings) return;
	const transcriptPolicy = resolveTranscriptPolicy({
		modelApi: params.model?.api,
		provider: params.provider,
		modelId: params.modelId
	});
	setContextPruningRuntime(params.sessionManager, {
		settings,
		contextWindowTokens: resolveContextWindowTokens(params),
		isToolPrunable: makeToolPrunablePredicate(settings.tools),
		dropThinkingBlocks: transcriptPolicy.dropThinkingBlocks,
		lastCacheTouchAt: readLastCacheTtlTimestamp(params.sessionManager, {
			provider: params.provider,
			modelId: params.modelId
		})
	});
	return contextPruningExtension;
}
function resolveCompactionMode(cfg) {
	const compaction = cfg?.agents?.defaults?.compaction;
	if (compaction?.provider) return "safeguard";
	return compaction?.mode === "safeguard" ? "safeguard" : "default";
}
function buildEmbeddedExtensionFactories(params) {
	const factories = [];
	if (resolveCompactionMode(params.cfg) === "safeguard") {
		const compactionCfg = params.cfg?.agents?.defaults?.compaction;
		const qualityGuardCfg = compactionCfg?.qualityGuard;
		const contextWindowInfo = resolveContextWindowInfo({
			cfg: params.cfg,
			provider: params.provider,
			modelId: params.modelId,
			modelContextTokens: params.model?.contextTokens,
			modelContextWindow: params.model?.contextWindow,
			defaultTokens: DEFAULT_CONTEXT_TOKENS
		});
		setCompactionSafeguardRuntime(params.sessionManager, {
			maxHistoryShare: compactionCfg?.maxHistoryShare,
			contextWindowTokens: contextWindowInfo.tokens,
			identifierPolicy: compactionCfg?.identifierPolicy,
			identifierInstructions: compactionCfg?.identifierInstructions,
			customInstructions: compactionCfg?.customInstructions,
			qualityGuardEnabled: qualityGuardCfg?.enabled ?? true,
			qualityGuardMaxRetries: qualityGuardCfg?.maxRetries,
			model: params.model,
			recentTurnsPreserve: compactionCfg?.recentTurnsPreserve,
			provider: compactionCfg?.provider
		});
		factories.push(compactionSafeguardExtension);
	}
	const pruningFactory = buildContextPruningFactory(params);
	if (pruningFactory) factories.push(pruningFactory);
	factories.push(buildAgentToolResultMiddlewareFactory());
	return factories;
}
//#endregion
//#region src/agents/pi-embedded-runner/history.ts
const THREAD_SUFFIX_REGEX = /^(.*)(?::(?:thread|topic):\d+)$/i;
function stripThreadSuffix(value) {
	return value.match(THREAD_SUFFIX_REGEX)?.[1] ?? value;
}
/**
* Limits conversation history to the last N user turns (and their associated
* assistant responses). This reduces token usage for long-running DM sessions.
*/
function limitHistoryTurns(messages, limit) {
	if (!limit || limit <= 0 || messages.length === 0) return messages;
	let userCount = 0;
	let lastUserIndex = messages.length;
	for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") {
		userCount++;
		if (userCount > limit) return messages.slice(lastUserIndex);
		lastUserIndex = i;
	}
	return messages;
}
/**
* Extract provider + user ID from a session key and look up dmHistoryLimit.
* Supports per-DM overrides and provider defaults.
* For channel/group sessions, uses historyLimit from provider config.
*/
function getHistoryLimitFromSessionKey(sessionKey, config) {
	if (!sessionKey || !config) return;
	const parts = sessionKey.split(":").filter(Boolean);
	const providerParts = parts.length >= 3 && parts[0] === "agent" ? parts.slice(2) : parts;
	const provider = normalizeProviderId(providerParts[0] ?? "");
	if (!provider) return;
	const kind = normalizeOptionalLowercaseString(providerParts[1]);
	const userId = stripThreadSuffix(providerParts.slice(2).join(":"));
	const resolveProviderConfig = (cfg, providerId) => {
		const channels = cfg?.channels;
		if (!channels || typeof channels !== "object") return;
		for (const [configuredProviderId, value] of Object.entries(channels)) {
			if (normalizeProviderId(configuredProviderId) !== providerId) continue;
			if (!value || typeof value !== "object" || Array.isArray(value)) return;
			return value;
		}
	};
	const providerConfig = resolveProviderConfig(config, provider);
	if (!providerConfig) return;
	if (kind === "dm" || kind === "direct") {
		if (userId && providerConfig.dms?.[userId]?.historyLimit !== void 0) return providerConfig.dms[userId].historyLimit;
		return providerConfig.dmHistoryLimit;
	}
	if (kind === "channel" || kind === "group") return providerConfig.historyLimit;
}
/**
* @deprecated Use getHistoryLimitFromSessionKey instead.
* Alias for backward compatibility.
*/
const getDmHistoryLimitFromSessionKey = getHistoryLimitFromSessionKey;
//#endregion
//#region src/agents/pi-embedded-runner/message-action-discovery-input.ts
function buildEmbeddedMessageActionDiscoveryInput(params) {
	return {
		cfg: params.cfg,
		channel: params.channel,
		currentChannelId: params.currentChannelId ?? void 0,
		currentThreadTs: params.currentThreadTs ?? void 0,
		currentMessageId: params.currentMessageId ?? void 0,
		accountId: params.accountId ?? void 0,
		sessionKey: params.sessionKey ?? void 0,
		sessionId: params.sessionId ?? void 0,
		agentId: params.agentId ?? void 0,
		requesterSenderId: params.senderId ?? void 0,
		senderIsOwner: params.senderIsOwner
	};
}
//#endregion
//#region src/agents/pi-embedded-runner/replay-history.ts
const MODEL_SNAPSHOT_CUSTOM_TYPE = "model-snapshot";
function createProviderReplayPluginParams(params) {
	const context = {
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		provider: params.provider,
		modelId: params.modelId,
		modelApi: params.modelApi,
		model: params.model,
		sessionId: params.sessionId
	};
	return {
		provider: params.provider,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		context
	};
}
function annotateInterSessionUserMessages(messages) {
	let touched = false;
	const out = [];
	for (const msg of messages) {
		if (!hasInterSessionUserProvenance(msg)) {
			out.push(msg);
			continue;
		}
		const provenance = normalizeInputProvenance(msg.provenance);
		const user = msg;
		if (typeof user.content === "string") {
			const annotated = annotateInterSessionPromptText(user.content, provenance);
			if (annotated === user.content) {
				out.push(msg);
				continue;
			}
			touched = true;
			out.push({
				...msg,
				content: annotated
			});
			continue;
		}
		if (!Array.isArray(user.content)) {
			out.push(msg);
			continue;
		}
		const textIndex = user.content.findIndex((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string");
		if (textIndex >= 0) {
			const existing = user.content[textIndex];
			const annotated = annotateInterSessionPromptText(existing.text, provenance);
			if (annotated === existing.text) {
				out.push(msg);
				continue;
			}
			const nextContent = [...user.content];
			nextContent[textIndex] = {
				...existing,
				text: annotated
			};
			touched = true;
			out.push({
				...msg,
				content: nextContent
			});
			continue;
		}
		touched = true;
		out.push({
			...msg,
			content: [{
				type: "text",
				text: annotateInterSessionPromptText("Inter-session content follows.", provenance)
			}, ...user.content]
		});
	}
	return touched ? out : messages;
}
function parseMessageTimestamp(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}
function stripStaleAssistantUsageBeforeLatestCompaction(messages) {
	let latestCompactionSummaryIndex = -1;
	let latestCompactionTimestamp = null;
	for (let i = 0; i < messages.length; i += 1) {
		const entry = messages[i];
		if (entry?.role !== "compactionSummary") continue;
		latestCompactionSummaryIndex = i;
		latestCompactionTimestamp = parseMessageTimestamp(entry.timestamp ?? null);
	}
	if (latestCompactionSummaryIndex === -1) return messages;
	const out = [...messages];
	let touched = false;
	for (let i = 0; i < out.length; i += 1) {
		const candidate = out[i];
		if (!candidate || candidate.role !== "assistant") continue;
		if (!candidate.usage || typeof candidate.usage !== "object") continue;
		const messageTimestamp = parseMessageTimestamp(candidate.timestamp);
		if (!(latestCompactionTimestamp !== null && messageTimestamp !== null && messageTimestamp <= latestCompactionTimestamp) && !(i < latestCompactionSummaryIndex)) continue;
		out[i] = {
			...candidate,
			usage: makeZeroUsageSnapshot()
		};
		touched = true;
	}
	return touched ? out : messages;
}
const TRANSCRIPT_ONLY_OPENCLAW_MODELS = new Set(["delivery-mirror", "gateway-injected"]);
function sanitizeUserReplayContent(message) {
	if (!message || message.role !== "user") return message;
	const replayContent = message.content;
	if (typeof replayContent === "string") return replayContent.trim() ? message : null;
	if (!Array.isArray(replayContent)) return message;
	let touched = false;
	const sanitizedContent = replayContent.filter((block) => {
		if (!block || typeof block !== "object") return true;
		if (block.type !== "text") return true;
		const text = block.text;
		if (typeof text !== "string" || text.trim().length > 0) return true;
		touched = true;
		return false;
	});
	if (sanitizedContent.length === 0) return null;
	return touched ? {
		...message,
		content: sanitizedContent
	} : message;
}
function isTranscriptOnlyOpenclawAssistant(message) {
	if (!message || message.role !== "assistant") return false;
	const provider = message.provider;
	const model = message.model;
	return provider === "openclaw" && typeof model === "string" && TRANSCRIPT_ONLY_OPENCLAW_MODELS.has(model);
}
function normalizeAssistantReplayTextContent(message, replayContent) {
	const strippedText = stripInboundMetadata(replayContent);
	if (!strippedText.trim()) return null;
	return {
		...message,
		content: [{
			type: "text",
			text: strippedText
		}]
	};
}
function normalizeAssistantReplayBlockContent(message, replayContent) {
	let touched = false;
	const sanitizedContent = [];
	for (const block of replayContent) {
		if (!block || typeof block !== "object") {
			sanitizedContent.push(block);
			continue;
		}
		const text = block.text;
		if (typeof text !== "string") {
			sanitizedContent.push(block);
			continue;
		}
		const strippedText = stripInboundMetadata(text);
		if (strippedText === text) {
			sanitizedContent.push(block);
			continue;
		}
		touched = true;
		if (strippedText.trim()) sanitizedContent.push({
			...block,
			text: strippedText
		});
	}
	if (!touched) return message;
	if (sanitizedContent.length === 0) return null;
	return {
		...message,
		content: sanitizedContent
	};
}
function normalizeAssistantReplayContent(messages) {
	let touched = false;
	const out = [];
	for (const message of messages) {
		if (message?.role === "user") {
			const sanitizedUserMessage = sanitizeUserReplayContent(message);
			if (sanitizedUserMessage) out.push(sanitizedUserMessage);
			if (sanitizedUserMessage !== message) touched = true;
			continue;
		}
		if (!message || message.role !== "assistant") {
			out.push(message);
			continue;
		}
		if (isTranscriptOnlyOpenclawAssistant(message)) {
			touched = true;
			continue;
		}
		const replayContent = message.content;
		if (typeof replayContent === "string") {
			const normalized = normalizeAssistantReplayTextContent(message, replayContent);
			if (normalized) out.push(normalized);
			touched = true;
			continue;
		}
		if (Array.isArray(replayContent)) {
			const normalized = normalizeAssistantReplayBlockContent(message, replayContent);
			if (normalized !== message) {
				if (normalized) out.push(normalized);
				touched = true;
				continue;
			}
		}
		if (Array.isArray(replayContent) && replayContent.length === 0) {
			if (message.stopReason === "error" || isZeroUsageEmptyStopAssistantTurn(message)) {
				out.push({
					...message,
					content: [{
						type: "text",
						text: STREAM_ERROR_FALLBACK_TEXT
					}]
				});
				touched = true;
				continue;
			}
		}
		out.push(message);
	}
	return touched ? out : messages;
}
function normalizeAssistantUsageSnapshot(usage) {
	const normalized = normalizeUsage(usage ?? void 0);
	if (!normalized) return makeZeroUsageSnapshot();
	const input = normalized.input ?? 0;
	const output = normalized.output ?? 0;
	const cacheRead = normalized.cacheRead ?? 0;
	const cacheWrite = normalized.cacheWrite ?? 0;
	const totalTokens = normalized.total ?? input + output + cacheRead + cacheWrite;
	const cost = normalizeAssistantUsageCost(usage);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		...cost ? { cost } : {}
	};
}
function normalizeAssistantUsageCost(usage) {
	const base = makeZeroUsageSnapshot().cost;
	if (!usage || typeof usage !== "object") return;
	const rawCost = usage.cost;
	if (!rawCost || typeof rawCost !== "object") return;
	const cost = rawCost;
	const inputRaw = toFiniteCostNumber(cost.input);
	const outputRaw = toFiniteCostNumber(cost.output);
	const cacheReadRaw = toFiniteCostNumber(cost.cacheRead);
	const cacheWriteRaw = toFiniteCostNumber(cost.cacheWrite);
	const totalRaw = toFiniteCostNumber(cost.total);
	if (inputRaw === void 0 && outputRaw === void 0 && cacheReadRaw === void 0 && cacheWriteRaw === void 0 && totalRaw === void 0) return;
	const input = inputRaw ?? base.input;
	const output = outputRaw ?? base.output;
	const cacheRead = cacheReadRaw ?? base.cacheRead;
	const cacheWrite = cacheWriteRaw ?? base.cacheWrite;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: totalRaw ?? input + output + cacheRead + cacheWrite
	};
}
function toFiniteCostNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function ensureAssistantUsageSnapshots(messages) {
	if (messages.length === 0) return messages;
	let touched = false;
	const out = [...messages];
	for (let i = 0; i < out.length; i += 1) {
		const message = out[i];
		if (!message || message.role !== "assistant") continue;
		const normalizedUsage = normalizeAssistantUsageSnapshot(message.usage);
		const usageCost = message.usage && typeof message.usage === "object" ? message.usage.cost : void 0;
		const normalizedCost = normalizedUsage.cost;
		if (message.usage && typeof message.usage === "object" && message.usage.input === normalizedUsage.input && message.usage.output === normalizedUsage.output && message.usage.cacheRead === normalizedUsage.cacheRead && message.usage.cacheWrite === normalizedUsage.cacheWrite && message.usage.totalTokens === normalizedUsage.totalTokens && (normalizedCost && usageCost && typeof usageCost === "object" && usageCost.input === normalizedCost.input && usageCost.output === normalizedCost.output && usageCost.cacheRead === normalizedCost.cacheRead && usageCost.cacheWrite === normalizedCost.cacheWrite && usageCost.total === normalizedCost.total || !normalizedCost && usageCost === void 0)) continue;
		out[i] = {
			...message,
			usage: normalizedUsage
		};
		touched = true;
	}
	return touched ? out : messages;
}
function createProviderReplaySessionState(sessionManager) {
	return {
		getCustomEntries() {
			try {
				const customEntries = [];
				for (const entry of sessionManager.getEntries()) {
					const candidate = entry;
					if (candidate?.type !== "custom" || typeof candidate.customType !== "string") continue;
					const customType = candidate.customType.trim();
					if (!customType) continue;
					customEntries.push({
						customType,
						data: candidate.data
					});
				}
				return customEntries;
			} catch {
				return [];
			}
		},
		appendCustomEntry(customType, data) {
			try {
				sessionManager.appendCustomEntry(customType, data);
			} catch {}
		}
	};
}
function readLastModelSnapshot(sessionManager) {
	try {
		const entries = sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i -= 1) {
			const entry = entries[i];
			if (entry?.type !== "custom" || entry?.customType !== MODEL_SNAPSHOT_CUSTOM_TYPE) continue;
			const data = entry?.data;
			if (data && typeof data === "object") return data;
		}
	} catch {
		return null;
	}
	return null;
}
function appendModelSnapshot(sessionManager, data) {
	try {
		sessionManager.appendCustomEntry(MODEL_SNAPSHOT_CUSTOM_TYPE, data);
	} catch {}
}
function isSameModelSnapshot(a, b) {
	const normalize = (value) => value ?? "";
	return normalize(a.provider) === normalize(b.provider) && normalize(a.modelApi) === normalize(b.modelApi) && normalize(a.modelId) === normalize(b.modelId);
}
/**
* Applies the generic replay-history cleanup pipeline before provider-owned
* replay hooks run.
*/
async function sanitizeSessionHistory(params) {
	const policy = params.policy ?? resolveTranscriptPolicy({
		modelApi: params.modelApi,
		provider: params.provider,
		modelId: params.modelId,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		model: params.model
	});
	const withInterSessionMarkers = annotateInterSessionUserMessages(params.messages);
	const allowProviderOwnedThinkingReplay = shouldAllowProviderOwnedThinkingReplay({
		modelApi: params.modelApi,
		policy
	});
	const isOpenAIResponsesApi = params.modelApi === "openai-responses" || params.modelApi === "openai-codex-responses" || params.modelApi === "azure-openai-responses";
	const hasSnapshot = Boolean(params.provider || params.modelApi || params.modelId);
	const priorSnapshot = hasSnapshot ? readLastModelSnapshot(params.sessionManager) : null;
	const modelChanged = priorSnapshot ? !isSameModelSnapshot(priorSnapshot, {
		timestamp: 0,
		provider: params.provider,
		modelApi: params.modelApi,
		modelId: params.modelId
	}) : false;
	const sanitizedImages = await sanitizeSessionMessagesImages(normalizeAssistantReplayContent(withInterSessionMarkers), "session:history", {
		sanitizeMode: policy.sanitizeMode,
		sanitizeToolCallIds: policy.sanitizeToolCallIds && !allowProviderOwnedThinkingReplay && !isOpenAIResponsesApi,
		toolCallIdMode: policy.toolCallIdMode,
		preserveNativeAnthropicToolUseIds: policy.preserveNativeAnthropicToolUseIds,
		preserveSignatures: policy.preserveSignatures,
		sanitizeThoughtSignatures: policy.sanitizeThoughtSignatures,
		...resolveImageSanitizationLimits(params.config)
	});
	const validatedThinkingSignatures = policy.preserveSignatures ? stripInvalidThinkingSignatures(sanitizedImages) : sanitizedImages;
	const droppedReasoning = policy.dropReasoningFromHistory ? dropReasoningFromHistory(validatedThinkingSignatures) : validatedThinkingSignatures;
	const sanitizedToolCalls = sanitizeToolCallInputs(policy.dropThinkingBlocks ? dropThinkingBlocks(droppedReasoning) : droppedReasoning, {
		allowedToolNames: params.allowedToolNames,
		allowProviderOwnedThinkingReplay
	});
	const openAIRepairedToolCalls = isOpenAIResponsesApi && policy.repairToolUseResultPairing ? sanitizeToolUseResultPairing(sanitizedToolCalls, {
		erroredAssistantResultPolicy: "drop",
		missingToolResultText: "aborted"
	}) : sanitizedToolCalls;
	const openAISafeToolCalls = isOpenAIResponsesApi ? downgradeOpenAIFunctionCallReasoningPairs(downgradeOpenAIReasoningBlocks(openAIRepairedToolCalls, { dropReplayableReasoning: modelChanged })) : sanitizedToolCalls;
	const sanitizedToolIds = policy.sanitizeToolCallIds && policy.toolCallIdMode ? sanitizeToolCallIdsForCloudCodeAssist(openAISafeToolCalls, policy.toolCallIdMode, {
		preserveNativeAnthropicToolUseIds: policy.preserveNativeAnthropicToolUseIds,
		preserveReplaySafeThinkingToolCallIds: allowProviderOwnedThinkingReplay,
		allowedToolNames: params.allowedToolNames
	}) : openAISafeToolCalls;
	const sanitizedCompactionUsage = ensureAssistantUsageSnapshots(stripStaleAssistantUsageBeforeLatestCompaction(stripToolResultDetails(!isOpenAIResponsesApi && policy.repairToolUseResultPairing ? sanitizeToolUseResultPairing(sanitizedToolIds, { erroredAssistantResultPolicy: "drop" }) : sanitizedToolIds)));
	const provider = params.provider?.trim();
	let providerSanitized;
	if (provider && provider.length > 0) {
		const pluginParams = createProviderReplayPluginParams({
			...params,
			provider
		});
		providerSanitized = await sanitizeProviderReplayHistoryWithPlugin({
			...pluginParams,
			context: {
				...pluginParams.context,
				sessionId: params.sessionId ?? "",
				messages: sanitizedCompactionUsage,
				allowedToolNames: params.allowedToolNames,
				sessionState: createProviderReplaySessionState(params.sessionManager)
			}
		}) ?? void 0;
	}
	const sanitizedWithProvider = providerSanitized ?? sanitizedCompactionUsage;
	if (hasSnapshot && (!priorSnapshot || modelChanged)) appendModelSnapshot(params.sessionManager, {
		timestamp: Date.now(),
		provider: params.provider,
		modelApi: params.modelApi,
		modelId: params.modelId
	});
	if (!policy.applyGoogleTurnOrdering) return sanitizedWithProvider;
	return sanitizeGoogleTurnOrdering(sanitizedWithProvider);
}
/**
* Runs provider-owned replay validation before falling back to the remaining
* generic validator pipeline.
*/
async function validateReplayTurns(params) {
	const policy = params.policy ?? resolveTranscriptPolicy({
		modelApi: params.modelApi,
		provider: params.provider,
		modelId: params.modelId,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		model: params.model
	});
	const provider = params.provider?.trim();
	if (provider) {
		const pluginParams = createProviderReplayPluginParams({
			...params,
			provider
		});
		const providerValidated = await validateProviderReplayTurnsWithPlugin({
			...pluginParams,
			context: {
				...pluginParams.context,
				messages: params.messages
			}
		});
		if (providerValidated) return providerValidated;
	}
	const validatedGemini = policy.validateGeminiTurns ? validateGeminiTurns(params.messages) : params.messages;
	return policy.validateAnthropicTurns ? validateAnthropicTurns(validatedGemini) : validatedGemini;
}
//#endregion
//#region src/agents/pi-embedded-runner/session-manager-cache.ts
const DEFAULT_SESSION_MANAGER_TTL_MS = 45e3;
const MIN_SESSION_MANAGER_CACHE_PRUNE_INTERVAL_MS = 1e3;
const MAX_SESSION_MANAGER_CACHE_PRUNE_INTERVAL_MS = 3e4;
function getSessionManagerTtl() {
	return resolveCacheTtlMs({
		envValue: process.env.OPENCLAW_SESSION_MANAGER_CACHE_TTL_MS,
		defaultTtlMs: DEFAULT_SESSION_MANAGER_TTL_MS
	});
}
function resolveSessionManagerCachePruneInterval(ttlMs) {
	return Math.min(Math.max(ttlMs, MIN_SESSION_MANAGER_CACHE_PRUNE_INTERVAL_MS), MAX_SESSION_MANAGER_CACHE_PRUNE_INTERVAL_MS);
}
function createSessionManagerCache(options) {
	const getTtlMs = () => typeof options?.ttlMs === "function" ? options.ttlMs() : options?.ttlMs ?? getSessionManagerTtl();
	const cache = createExpiringMapCache({
		ttlMs: getTtlMs,
		pruneIntervalMs: resolveSessionManagerCachePruneInterval,
		clock: options?.clock
	});
	const fsModule = options?.fsModule ?? fs$1;
	return {
		clear: () => {
			cache.clear();
		},
		isSessionManagerCached: (sessionFile) => cache.get(sessionFile) === true,
		keys: () => cache.keys(),
		prewarmSessionFile: async (sessionFile) => {
			if (!isCacheEnabled(getTtlMs())) return;
			if (cache.get(sessionFile) === true) return;
			try {
				const handle = await fsModule.open(sessionFile, "r");
				try {
					const buffer = Buffer$1.alloc(4096);
					await handle.read(buffer, 0, buffer.length, 0);
				} finally {
					await handle.close();
				}
				cache.set(sessionFile, true);
			} catch {}
		},
		trackSessionManagerAccess: (sessionFile) => {
			cache.set(sessionFile, true);
		}
	};
}
const sessionManagerCache = createSessionManagerCache();
function trackSessionManagerAccess(sessionFile) {
	sessionManagerCache.trackSessionManagerAccess(sessionFile);
}
async function prewarmSessionFile(sessionFile) {
	await sessionManagerCache.prewarmSessionFile(sessionFile);
}
//#endregion
//#region src/agents/pi-embedded-runner/skills-runtime.ts
function resolveEmbeddedRunSkillEntries(params) {
	const shouldLoadSkillEntries = !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
	const config = resolveSkillRuntimeConfig(params.config);
	return {
		shouldLoadSkillEntries,
		skillEntries: shouldLoadSkillEntries ? loadWorkspaceSkillEntries(params.workspaceDir, {
			config,
			agentId: params.agentId
		}) : []
	};
}
//#endregion
//#region src/agents/pi-embedded-runner/stream-resolution.ts
let embeddedAgentBaseStreamFnCache = /* @__PURE__ */ new WeakMap();
function resolveEmbeddedAgentBaseStreamFn(params) {
	const cached = embeddedAgentBaseStreamFnCache.get(params.session);
	if (cached !== void 0 || embeddedAgentBaseStreamFnCache.has(params.session)) return cached;
	const baseStreamFn = params.session.agent.streamFn;
	embeddedAgentBaseStreamFnCache.set(params.session, baseStreamFn);
	return baseStreamFn;
}
function describeEmbeddedAgentStreamStrategy(params) {
	if (params.providerStreamFn) return "provider";
	if (params.shouldUseWebSocketTransport) return params.wsApiKey ? "openai-websocket" : "session-http-fallback";
	if (params.model.provider === "anthropic-vertex") return "anthropic-vertex";
	if (params.currentStreamFn === void 0 || params.currentStreamFn === streamSimple) return createBoundaryAwareStreamFnForModel(params.model) ? `boundary-aware:${params.model.api}` : "stream-simple";
	return "session-custom";
}
async function resolveEmbeddedAgentApiKey(params) {
	const resolvedApiKey = params.resolvedApiKey?.trim();
	if (resolvedApiKey) return resolvedApiKey;
	return params.authStorage ? await params.authStorage.getApiKey(params.provider) : void 0;
}
function resolveEmbeddedAgentStreamFn(params) {
	if (params.providerStreamFn) return wrapEmbeddedAgentStreamFn(params.providerStreamFn, {
		runSignal: params.signal,
		resolvedApiKey: params.resolvedApiKey,
		authStorage: params.authStorage,
		providerId: params.model.provider,
		transformContext: (context) => context.systemPrompt ? {
			...context,
			systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt)
		} : context
	});
	const currentStreamFn = params.currentStreamFn ?? streamSimple;
	if (params.shouldUseWebSocketTransport) return params.wsApiKey ? createOpenAIWebSocketStreamFn(params.wsApiKey, params.sessionId, {
		signal: params.signal,
		managerOptions: { request: getModelProviderRequestTransport(params.model) }
	}) : currentStreamFn;
	if (params.model.provider === "anthropic-vertex") return createAnthropicVertexStreamFnForModel(params.model);
	if (params.currentStreamFn === void 0 || params.currentStreamFn === streamSimple) {
		const boundaryAwareStreamFn = createBoundaryAwareStreamFnForModel(params.model);
		if (boundaryAwareStreamFn) return wrapEmbeddedAgentStreamFn(boundaryAwareStreamFn, {
			runSignal: params.signal,
			resolvedApiKey: params.resolvedApiKey,
			authStorage: params.authStorage,
			providerId: params.model.provider
		});
	}
	return currentStreamFn;
}
function wrapEmbeddedAgentStreamFn(inner, params) {
	const transformContext = params.transformContext ?? ((context) => context);
	const mergeRunSignal = (options) => {
		const signal = options?.signal ?? params.runSignal;
		return signal ? {
			...options,
			signal
		} : options;
	};
	if (!params.authStorage && !params.resolvedApiKey) return (m, context, options) => inner(m, transformContext(context), mergeRunSignal(options));
	const { authStorage, providerId, resolvedApiKey } = params;
	return async (m, context, options) => {
		const apiKey = await resolveEmbeddedAgentApiKey({
			provider: providerId,
			resolvedApiKey,
			authStorage
		});
		return inner(m, transformContext(context), {
			...mergeRunSignal(options),
			apiKey: apiKey ?? options?.apiKey
		});
	};
}
//#endregion
//#region src/agents/pi-embedded-runner/system-prompt.ts
function buildEmbeddedSystemPrompt(params) {
	return buildAgentSystemPrompt({
		workspaceDir: params.workspaceDir,
		defaultThinkLevel: params.defaultThinkLevel,
		reasoningLevel: params.reasoningLevel,
		extraSystemPrompt: params.extraSystemPrompt,
		ownerNumbers: params.ownerNumbers,
		ownerDisplay: params.ownerDisplay,
		ownerDisplaySecret: params.ownerDisplaySecret,
		reasoningTagHint: params.reasoningTagHint,
		heartbeatPrompt: params.heartbeatPrompt,
		skillsPrompt: params.skillsPrompt,
		docsPath: params.docsPath,
		sourcePath: params.sourcePath,
		ttsHint: params.ttsHint,
		workspaceNotes: params.workspaceNotes,
		reactionGuidance: params.reactionGuidance,
		promptMode: params.promptMode,
		silentReplyPromptMode: params.silentReplyPromptMode,
		sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
		acpEnabled: params.acpEnabled,
		nativeCommandNames: params.nativeCommandNames,
		nativeCommandGuidanceLines: params.nativeCommandGuidanceLines,
		runtimeInfo: params.runtimeInfo,
		messageToolHints: params.messageToolHints,
		sandboxInfo: params.sandboxInfo,
		toolNames: params.tools.map((tool) => tool.name),
		modelAliasLines: params.modelAliasLines,
		userTimezone: params.userTimezone,
		userTime: params.userTime,
		userTimeFormat: params.userTimeFormat,
		contextFiles: params.contextFiles,
		includeMemorySection: params.includeMemorySection,
		memoryCitationsMode: params.memoryCitationsMode,
		promptContribution: params.promptContribution,
		continuationEnabled: params.continuationEnabled
	});
}
function createSystemPromptOverride(systemPrompt) {
	const override = systemPrompt.trim();
	return (_defaultPrompt) => override;
}
function applySystemPromptOverrideToSession(session, override) {
	const prompt = typeof override === "function" ? override() : override.trim();
	session.agent.state.systemPrompt = prompt;
	const mutableSession = session;
	mutableSession._baseSystemPrompt = prompt;
	mutableSession._rebuildSystemPrompt = () => prompt;
}
//#endregion
//#region src/agents/pi-embedded-runner/tool-name-allowlist.ts
/**
* Pi built-in tools that remain present in the embedded runtime even when
* OpenClaw routes execution through custom tool definitions.
*/
const PI_RESERVED_TOOL_NAMES = [
	"bash",
	"edit",
	"find",
	"grep",
	"ls",
	"read",
	"write"
];
function addName(names, value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	if (trimmed) names.add(trimmed);
}
function collectAllowedToolNames(params) {
	const names = /* @__PURE__ */ new Set();
	for (const tool of params.tools) addName(names, tool.name);
	for (const tool of params.clientTools ?? []) addName(names, tool.function?.name);
	return names;
}
/**
* Collect the exact tool names registered with Pi for this session.
*/
function collectRegisteredToolNames(tools) {
	const names = /* @__PURE__ */ new Set();
	for (const tool of tools) addName(names, tool.name);
	return names;
}
function toSessionToolAllowlist(allowedToolNames) {
	return [...new Set(allowedToolNames)].toSorted((a, b) => a.localeCompare(b));
}
//#endregion
//#region src/agents/pi-embedded-runner/tool-split.ts
function splitSdkTools(options) {
	const { tools } = options;
	return { customTools: toToolDefinitions(tools) };
}
//#endregion
//#region src/agents/pi-embedded-runner/utils.ts
function mapThinkingLevel(level) {
	if (!level) return "off";
	if (level === "max") return "xhigh";
	if (level === "adaptive") return "medium";
	return level;
}
//#endregion
//#region src/agents/pi-embedded-runner/wait-for-idle-before-flush.ts
const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 3e4;
async function waitForAgentIdleBestEffort(agent, timeoutMs) {
	const waitForIdle = agent?.waitForIdle;
	if (typeof waitForIdle !== "function") return false;
	const idleResolved = Symbol("idle");
	const idleTimedOut = Symbol("timeout");
	let timeoutHandle;
	try {
		return await Promise.race([waitForIdle.call(agent).then(() => idleResolved), new Promise((resolve) => {
			timeoutHandle = setTimeout(() => resolve(idleTimedOut), timeoutMs);
			timeoutHandle.unref?.();
		})]) === idleTimedOut;
	} catch {
		return false;
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
	}
}
async function flushPendingToolResultsAfterIdle(opts) {
	if (await waitForAgentIdleBestEffort(opts.agent, opts.timeoutMs ?? DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS) && opts.clearPendingOnTimeout && opts.sessionManager?.clearPendingToolResults) {
		opts.sessionManager.clearPendingToolResults();
		return;
	}
	opts.sessionManager?.flushPendingToolResults?.();
}
//#endregion
//#region src/agents/pi-embedded-runner/compaction-duplicate-user-messages.ts
const DEFAULT_DUPLICATE_USER_MESSAGE_WINDOW_MS = 6e4;
const MIN_DUPLICATE_USER_MESSAGE_CHARS = 24;
function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function normalizeUserMessageContent(content) {
	if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
	if (!Array.isArray(content)) return;
	const textParts = [];
	for (const block of content) {
		if (!isRecord(block)) return;
		if (block.type === "image") return;
		if (block.type === "text" && typeof block.text === "string") textParts.push(block.text);
	}
	return textParts.join("\n").replace(/\s+/g, " ").trim();
}
function duplicateSignature(message) {
	if (!isRecord(message) || message.role !== "user" || typeof message.timestamp !== "number") return;
	const text = normalizeUserMessageContent(message.content);
	if (!text || text.length < MIN_DUPLICATE_USER_MESSAGE_CHARS) return;
	return {
		key: text.normalize("NFC").toLowerCase(),
		timestamp: message.timestamp
	};
}
function dedupeDuplicateUserMessagesForCompaction(messages, options = {}) {
	const windowMs = options.windowMs ?? DEFAULT_DUPLICATE_USER_MESSAGE_WINDOW_MS;
	const lastSeenAtByKey = /* @__PURE__ */ new Map();
	let removed = 0;
	const result = [];
	for (const message of messages) {
		const signature = duplicateSignature(message);
		if (!signature) {
			result.push(message);
			continue;
		}
		const lastSeenAt = lastSeenAtByKey.get(signature.key);
		lastSeenAtByKey.set(signature.key, signature.timestamp);
		if (typeof lastSeenAt === "number" && signature.timestamp - lastSeenAt <= windowMs) {
			removed += 1;
			continue;
		}
		result.push(message);
	}
	return removed > 0 ? result : [...messages];
}
function collectDuplicateUserMessageEntryIdsForCompaction(entries, options = {}) {
	const windowMs = options.windowMs ?? DEFAULT_DUPLICATE_USER_MESSAGE_WINDOW_MS;
	const lastSeenAtByKey = /* @__PURE__ */ new Map();
	const duplicateIds = /* @__PURE__ */ new Set();
	for (const entry of entries) {
		if (entry.type !== "message" || typeof entry.id !== "string") continue;
		const signature = duplicateSignature(isRecord(entry.message) ? entry.message : void 0);
		if (!signature) continue;
		const lastSeenAt = lastSeenAtByKey.get(signature.key);
		lastSeenAtByKey.set(signature.key, signature.timestamp);
		if (typeof lastSeenAt === "number" && signature.timestamp - lastSeenAt <= windowMs) duplicateIds.add(entry.id);
	}
	return duplicateIds;
}
//#endregion
//#region src/agents/pi-embedded-runner/compaction-successor-transcript.ts
function shouldRotateCompactionTranscript(config) {
	return config?.agents?.defaults?.compaction?.truncateAfterCompaction === true;
}
async function rotateTranscriptAfterCompaction(params) {
	const sessionFile = params.sessionFile.trim();
	if (!sessionFile) return {
		rotated: false,
		reason: "missing session file"
	};
	const branch = params.sessionManager.getBranch();
	const latestCompactionIndex = findLatestCompactionIndex(branch);
	if (latestCompactionIndex < 0) return {
		rotated: false,
		reason: "no compaction entry"
	};
	const compaction = branch[latestCompactionIndex];
	const timestamp = (params.now?.() ?? /* @__PURE__ */ new Date()).toISOString();
	const sessionId = randomUUID();
	const successorFile = resolveSuccessorSessionFile({
		sessionFile,
		sessionId,
		timestamp
	});
	const successorEntries = buildSuccessorEntries({
		allEntries: params.sessionManager.getEntries(),
		branch,
		latestCompactionIndex
	});
	if (successorEntries.length === 0) return {
		rotated: false,
		reason: "empty successor transcript"
	};
	const header = buildSuccessorHeader({
		previousHeader: params.sessionManager.getHeader(),
		sessionId,
		timestamp,
		cwd: params.sessionManager.getCwd(),
		parentSession: sessionFile
	});
	await writeTranscriptFileAtomic(successorFile, [header, ...successorEntries]);
	new TranscriptFileState({
		header,
		entries: successorEntries
	}).buildSessionContext();
	return {
		rotated: true,
		sessionId,
		sessionFile: successorFile,
		compactionEntryId: compaction.id,
		leafId: successorEntries[successorEntries.length - 1]?.id,
		entriesWritten: successorEntries.length
	};
}
async function rotateTranscriptFileAfterCompaction(params) {
	return rotateTranscriptAfterCompaction({
		sessionManager: await readTranscriptFileState(params.sessionFile),
		sessionFile: params.sessionFile,
		...params.now ? { now: params.now } : {}
	});
}
function findLatestCompactionIndex(entries) {
	for (let index = entries.length - 1; index >= 0; index -= 1) if (entries[index]?.type === "compaction") return index;
	return -1;
}
function buildSuccessorEntries(params) {
	const { allEntries, branch, latestCompactionIndex } = params;
	const compaction = branch[latestCompactionIndex];
	const summarizedBranchIds = /* @__PURE__ */ new Set();
	for (let index = 0; index < latestCompactionIndex; index += 1) {
		const entry = branch[index];
		if (!entry) continue;
		if (compaction.firstKeptEntryId && entry.id === compaction.firstKeptEntryId) break;
		summarizedBranchIds.add(entry.id);
	}
	const latestStateEntryIds = collectLatestStateEntryIds(branch.slice(0, latestCompactionIndex));
	const staleStateEntryIds = /* @__PURE__ */ new Set();
	for (const entry of branch.slice(0, latestCompactionIndex)) if (isDedupedStateEntry(entry) && !latestStateEntryIds.has(entry.id)) staleStateEntryIds.add(entry.id);
	const removedIds = /* @__PURE__ */ new Set();
	const duplicateUserMessageIds = collectDuplicateUserMessageEntryIdsForCompaction(branch);
	for (const entry of allEntries) if (summarizedBranchIds.has(entry.id) && entry.type === "message" || staleStateEntryIds.has(entry.id) || duplicateUserMessageIds.has(entry.id)) removedIds.add(entry.id);
	for (const entry of allEntries) if (entry.type === "label" && removedIds.has(entry.targetId)) removedIds.add(entry.id);
	const entryById = new Map(allEntries.map((entry) => [entry.id, entry]));
	const activeBranchIds = new Set(branch.map((entry) => entry.id));
	const originalIndexById = new Map(allEntries.map((entry, index) => [entry.id, index]));
	const keptEntries = [];
	for (const entry of allEntries) {
		if (removedIds.has(entry.id)) continue;
		let parentId = entry.parentId;
		while (parentId !== null && removedIds.has(parentId)) parentId = entryById.get(parentId)?.parentId ?? null;
		keptEntries.push(parentId === entry.parentId ? entry : {
			...entry,
			parentId
		});
	}
	return orderSuccessorEntries({
		entries: keptEntries,
		activeBranchIds,
		originalIndexById
	});
}
function collectLatestStateEntryIds(entries) {
	const latestByType = /* @__PURE__ */ new Map();
	for (const entry of entries) if (isDedupedStateEntry(entry)) latestByType.set(entry.type, entry);
	return new Set(Array.from(latestByType.values(), (entry) => entry.id));
}
function isDedupedStateEntry(entry) {
	return entry.type === "model_change" || entry.type === "thinking_level_change" || entry.type === "session_info";
}
function orderSuccessorEntries(params) {
	const { entries, activeBranchIds, originalIndexById } = params;
	const entryIds = new Set(entries.map((entry) => entry.id));
	const childrenByParentId = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		const parentId = entry.parentId !== null && entryIds.has(entry.parentId) ? entry.parentId : null;
		const children = childrenByParentId.get(parentId) ?? [];
		children.push(parentId === entry.parentId ? entry : {
			...entry,
			parentId
		});
		childrenByParentId.set(parentId, children);
	}
	const sortForActiveLeaf = (left, right) => {
		const leftActive = activeBranchIds.has(left.id);
		if (leftActive !== activeBranchIds.has(right.id)) return leftActive ? 1 : -1;
		return (originalIndexById.get(left.id) ?? 0) - (originalIndexById.get(right.id) ?? 0);
	};
	const ordered = [];
	const emittedIds = /* @__PURE__ */ new Set();
	const emitSubtree = (entry) => {
		if (emittedIds.has(entry.id)) return;
		emittedIds.add(entry.id);
		ordered.push(entry);
		for (const child of (childrenByParentId.get(entry.id) ?? []).toSorted(sortForActiveLeaf)) emitSubtree(child);
	};
	for (const root of (childrenByParentId.get(null) ?? []).toSorted(sortForActiveLeaf)) emitSubtree(root);
	for (const entry of entries.toSorted(sortForActiveLeaf)) emitSubtree(entry);
	return ordered;
}
function buildSuccessorHeader(params) {
	return {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: params.sessionId,
		timestamp: params.timestamp,
		cwd: params.previousHeader?.cwd || params.cwd,
		parentSession: params.parentSession
	};
}
function resolveSuccessorSessionFile(params) {
	const fileTimestamp = params.timestamp.replace(/[:.]/g, "-");
	return path.join(path.dirname(params.sessionFile), `${fileTimestamp}_${params.sessionId}.jsonl`);
}
//#endregion
export { isRealConversationMessage as A, collectRuntimeChannelCapabilities as B, sanitizeSessionHistory as C, limitHistoryTurns as D, getDmHistoryLimitFromSessionKey as E, resolveCompactionTimeoutMs as F, releaseWsSession as G, dropReasoningFromHistory as H, isCacheTtlEligibleProvider as I, buildStreamErrorAssistantMessage as K, readLastCacheTtlTimestamp as L, consumeCompactionSafeguardCancelReason as M, setCompactionSafeguardCancelReason as N, buildEmbeddedExtensionFactories as O, compactWithSafetyTimeout as P, guardSessionManager as R, normalizeAssistantReplayContent as S, buildEmbeddedMessageActionDiscoveryInput as T, dropThinkingBlocks as U, assessLastAssistantMessage as V, isZeroUsageEmptyStopAssistantTurn as W, resolveEmbeddedAgentBaseStreamFn as _, flushPendingToolResultsAfterIdle as a, prewarmSessionFile as b, PI_RESERVED_TOOL_NAMES as c, toSessionToolAllowlist as d, applySystemPromptOverrideToSession as f, resolveEmbeddedAgentApiKey as g, describeEmbeddedAgentStreamStrategy as h, dedupeDuplicateUserMessagesForCompaction as i, readPostCompactionContext as j, hasMeaningfulConversationContent as k, collectAllowedToolNames as l, createSystemPromptOverride as m, rotateTranscriptFileAfterCompaction as n, mapThinkingLevel as o, buildEmbeddedSystemPrompt as p, buildUsageWithNoCost as q, shouldRotateCompactionTranscript as r, splitSdkTools as s, rotateTranscriptAfterCompaction as t, collectRegisteredToolNames as u, resolveEmbeddedAgentStreamFn as v, validateReplayTurns as w, trackSessionManagerAccess as x, resolveEmbeddedRunSkillEntries as y, repairSessionFileIfNeeded as z };
