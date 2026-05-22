import { d as normalizeSecretInputString, u as normalizeResolvedSecretInputString } from "./types.secrets-m6J7qPGz.js";
import { s as resolveProviderRequestHeaders } from "./provider-request-config-DjRpGxNy.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-DGYfmBq6.js";
import { a as createProviderHttpError } from "./provider-http-errors-DexvZ6AR.js";
import { n as createDebugProxyWebSocketAgent, r as resolveDebugProxySettings } from "./env-Bd9j22Bo.js";
import "./secret-input-CPrRyGK6.js";
import { n as captureWsEvent } from "./runtime-D86OMXsq.js";
import "./proxy-capture-B46sqeH7.js";
import "./ssrf-runtime-BdcRu7L4.js";
import "./provider-http-DNXg86bS.js";
import { A as REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ, k as REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ } from "./session-runtime-CcoRPKPC.js";
import "./realtime-voice-i_ctAAzZ.js";
import { a as resolveOpenAIProviderConfigRecord, i as readRealtimeErrorDetail, o as trimToUndefined, r as captureOpenAIRealtimeWsClose, t as asFiniteNumber } from "./realtime-provider-shared-Br2kQHd1.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
//#region extensions/openai/realtime-voice-provider.ts
const OPENAI_REALTIME_DEFAULT_MODEL = "gpt-realtime-2";
const OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const OPENAI_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX = "Conversation already has an active response in progress:";
const OPENAI_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR = "Cancellation failed: no active response found";
const OPENAI_REALTIME_DEFAULT_MIN_BARGE_IN_AUDIO_END_MS = 250;
function normalizeProviderConfig(config) {
	const raw = resolveOpenAIProviderConfigRecord(config);
	return {
		apiKey: normalizeResolvedSecretInputString({
			value: raw?.apiKey,
			path: "plugins.entries.voice-call.config.realtime.providers.openai.apiKey"
		}),
		model: trimToUndefined(raw?.model),
		voice: trimToUndefined(raw?.voice),
		temperature: asFiniteNumber(raw?.temperature),
		vadThreshold: asFiniteNumber(raw?.vadThreshold),
		silenceDurationMs: asFiniteNumber(raw?.silenceDurationMs),
		prefixPaddingMs: asFiniteNumber(raw?.prefixPaddingMs),
		interruptResponseOnInputAudio: typeof raw?.interruptResponseOnInputAudio === "boolean" ? raw.interruptResponseOnInputAudio : void 0,
		minBargeInAudioEndMs: asNonNegativeInteger(raw?.minBargeInAudioEndMs),
		azureEndpoint: trimToUndefined(raw?.azureEndpoint),
		azureDeployment: trimToUndefined(raw?.azureDeployment),
		azureApiVersion: trimToUndefined(raw?.azureApiVersion)
	};
}
function asNonNegativeInteger(value) {
	const number = asFiniteNumber(value);
	return number === void 0 || number < 0 ? void 0 : Math.floor(number);
}
const KEYCHAIN_SECRET_REF_RE = /^keychain:([^:]+):([^:]+)$/;
const KEYCHAIN_LOOKUP_TIMEOUT_MS = 5e3;
const resolvedKeychainSecretRefCache = /* @__PURE__ */ new Map();
function resolveKeychainSecretRef(value) {
	const trimmed = value.trim();
	const match = KEYCHAIN_SECRET_REF_RE.exec(trimmed);
	if (!match) return trimmed || void 0;
	const cached = resolvedKeychainSecretRefCache.get(trimmed);
	if (cached) return cached;
	const [, service, account] = match;
	try {
		const resolved = execFileSync("/usr/bin/security", [
			"find-generic-password",
			"-s",
			service,
			"-a",
			account,
			"-w"
		], {
			encoding: "utf8",
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			timeout: KEYCHAIN_LOOKUP_TIMEOUT_MS
		}).trim() || void 0;
		if (resolved) resolvedKeychainSecretRefCache.set(trimmed, resolved);
		return resolved;
	} catch {
		return;
	}
}
function resolveOpenAIRealtimeApiKey(configuredApiKey) {
	const configured = normalizeSecretInputString(configuredApiKey);
	if (configured) {
		const value = resolveKeychainSecretRef(configured);
		return value ? {
			status: "available",
			value
		} : { status: "missing" };
	}
	const envValue = normalizeSecretInputString(process.env.OPENAI_API_KEY);
	if (!envValue) return { status: "missing" };
	const value = resolveKeychainSecretRef(envValue);
	return value ? {
		status: "available",
		value
	} : { status: "missing" };
}
function requireOpenAIRealtimeApiKey(configuredApiKey) {
	const resolved = resolveOpenAIRealtimeApiKey(configuredApiKey);
	if (resolved.status === "available") return resolved.value;
	throw new Error("OpenAI API key missing");
}
function hasOpenAIRealtimeApiKeyInput(configuredApiKey) {
	return Boolean(normalizeSecretInputString(configuredApiKey) ?? normalizeSecretInputString(process.env.OPENAI_API_KEY));
}
function base64ToBuffer(b64) {
	return Buffer.from(b64, "base64");
}
var OpenAIRealtimeVoiceBridge = class OpenAIRealtimeVoiceBridge {
	static {
		this.DEFAULT_MODEL = OPENAI_REALTIME_DEFAULT_MODEL;
	}
	static {
		this.MAX_RECONNECT_ATTEMPTS = 5;
	}
	static {
		this.BASE_RECONNECT_DELAY_MS = 1e3;
	}
	static {
		this.CONNECT_TIMEOUT_MS = 1e4;
	}
	constructor(config) {
		this.config = config;
		this.supportsToolResultContinuation = true;
		this.ws = null;
		this.connected = false;
		this.sessionConfigured = false;
		this.intentionallyClosed = false;
		this.reconnectAttempts = 0;
		this.pendingAudio = [];
		this.markQueue = [];
		this.responseStartTimestamp = null;
		this.responseActive = false;
		this.responseCreateInFlight = false;
		this.responseCancelInFlight = false;
		this.responseCreatePending = false;
		this.continuingToolCallIds = /* @__PURE__ */ new Set();
		this.latestMediaTimestamp = 0;
		this.lastAssistantItemId = null;
		this.toolCallBuffers = /* @__PURE__ */ new Map();
		this.deliveredToolCallKeys = /* @__PURE__ */ new Set();
		this.flowId = randomUUID();
		this.sessionReadyFired = false;
		this.audioFormat = config.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ;
	}
	async connect() {
		this.intentionallyClosed = false;
		this.reconnectAttempts = 0;
		await this.doConnect();
	}
	sendAudio(audio) {
		if (!this.connected || !this.sessionConfigured || this.ws?.readyState !== WebSocket.OPEN) {
			if (this.pendingAudio.length < 320) this.pendingAudio.push(audio);
			return;
		}
		this.sendEvent({
			type: "input_audio_buffer.append",
			audio: audio.toString("base64")
		});
	}
	setMediaTimestamp(ts) {
		this.latestMediaTimestamp = ts;
	}
	sendUserMessage(text) {
		this.sendEvent({
			type: "conversation.item.create",
			item: {
				type: "message",
				role: "user",
				content: [{
					type: "input_text",
					text
				}]
			}
		});
		this.requestResponseCreate();
	}
	triggerGreeting(instructions) {
		if (!this.isConnected() || !this.ws) return;
		this.sendUserMessage(instructions ?? this.config.instructions ?? "Greet the meeting.");
	}
	submitToolResult(callId, result, options) {
		this.sendEvent({
			type: "conversation.item.create",
			item: {
				type: "function_call_output",
				call_id: callId,
				output: JSON.stringify(result)
			}
		});
		if (options?.willContinue === true) {
			this.continuingToolCallIds.add(callId);
			return;
		}
		this.continuingToolCallIds.delete(callId);
		if (options?.suppressResponse === true) return;
		this.requestResponseCreate();
	}
	acknowledgeMark() {
		if (this.markQueue.length === 0) return;
		this.markQueue.shift();
	}
	close() {
		this.intentionallyClosed = true;
		this.connected = false;
		this.sessionConfigured = false;
		if (this.ws) {
			this.ws.close(1e3, "Bridge closed");
			this.ws = null;
		}
	}
	isConnected() {
		return this.connected && this.sessionConfigured;
	}
	async doConnect() {
		await new Promise((resolve, reject) => {
			let connectTimeout;
			let settled = false;
			const settleResolve = () => {
				if (settled) return;
				settled = true;
				clearTimeout(connectTimeout);
				resolve();
			};
			const settleReject = (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(connectTimeout);
				reject(error);
			};
			const { url, headers } = this.resolveConnectionParams();
			const proxyAgent = createDebugProxyWebSocketAgent(resolveDebugProxySettings());
			this.ws = new WebSocket(url, {
				headers,
				...proxyAgent ? { agent: proxyAgent } : {}
			});
			connectTimeout = setTimeout(() => {
				if (!this.sessionConfigured && !this.intentionallyClosed) {
					this.ws?.terminate();
					settleReject(/* @__PURE__ */ new Error("OpenAI realtime connection timeout"));
				}
			}, OpenAIRealtimeVoiceBridge.CONNECT_TIMEOUT_MS);
			this.ws.on("open", () => {
				this.resetRealtimeSessionState();
				this.connected = true;
				this.sessionConfigured = false;
				this.reconnectAttempts = 0;
				captureWsEvent({
					url,
					direction: "local",
					kind: "ws-open",
					flowId: this.flowId,
					meta: {
						provider: "openai",
						capability: "realtime-voice"
					}
				});
				this.sendSessionUpdate();
			});
			this.ws.on("message", (data) => {
				captureWsEvent({
					url,
					direction: "inbound",
					kind: "ws-frame",
					flowId: this.flowId,
					payload: data,
					meta: {
						provider: "openai",
						capability: "realtime-voice"
					}
				});
				try {
					const event = JSON.parse(data.toString());
					this.handleEvent(event);
					if (event.type === "session.updated") settleResolve();
					if (event.type === "error" && !this.sessionConfigured) settleReject(new Error(readRealtimeErrorDetail(event.error)));
				} catch (error) {
					console.error("[openai] realtime event parse failed:", error);
				}
			});
			this.ws.on("error", (error) => {
				captureWsEvent({
					url,
					direction: "local",
					kind: "error",
					flowId: this.flowId,
					errorText: error instanceof Error ? error.message : String(error),
					meta: {
						provider: "openai",
						capability: "realtime-voice"
					}
				});
				if (!this.sessionConfigured) settleReject(error instanceof Error ? error : new Error(String(error)));
				this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
			});
			this.ws.on("close", (code, reasonBuffer) => {
				captureOpenAIRealtimeWsClose({
					url,
					flowId: this.flowId,
					capability: "realtime-voice",
					code,
					reasonBuffer
				});
				this.connected = false;
				this.sessionConfigured = false;
				if (this.intentionallyClosed) {
					settleResolve();
					this.config.onClose?.("completed");
					return;
				}
				if (!this.sessionConfigured && !settled) {
					settleReject(/* @__PURE__ */ new Error("OpenAI realtime connection closed before ready"));
					return;
				}
				this.attemptReconnect();
			});
		});
	}
	resolveConnectionParams() {
		const cfg = this.config;
		if (cfg.azureEndpoint && cfg.azureDeployment) {
			const url = `${cfg.azureEndpoint.replace(/\/$/, "").replace(/^http(s?):/, (_, secure) => `ws${secure}:`)}/openai/realtime?api-version=${cfg.azureApiVersion ?? "2024-10-01-preview"}&deployment=${encodeURIComponent(cfg.azureDeployment)}`;
			return {
				url,
				headers: resolveProviderRequestHeaders({
					provider: "openai",
					baseUrl: url,
					capability: "audio",
					transport: "websocket",
					defaultHeaders: { "api-key": cfg.apiKey }
				}) ?? { "api-key": cfg.apiKey }
			};
		}
		if (cfg.azureEndpoint) {
			const url = `${cfg.azureEndpoint.replace(/\/$/, "").replace(/^http(s?):/, (_, secure) => `ws${secure}:`)}/v1/realtime?model=${encodeURIComponent(cfg.model ?? OpenAIRealtimeVoiceBridge.DEFAULT_MODEL)}`;
			return {
				url,
				headers: resolveProviderRequestHeaders({
					provider: "openai",
					baseUrl: url,
					capability: "audio",
					transport: "websocket",
					defaultHeaders: { Authorization: `Bearer ${cfg.apiKey}` }
				}) ?? { Authorization: `Bearer ${cfg.apiKey}` }
			};
		}
		const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(cfg.model ?? OpenAIRealtimeVoiceBridge.DEFAULT_MODEL)}`;
		return {
			url,
			headers: resolveProviderRequestHeaders({
				provider: "openai",
				baseUrl: url,
				capability: "audio",
				transport: "websocket",
				defaultHeaders: { Authorization: `Bearer ${cfg.apiKey}` }
			}) ?? { Authorization: `Bearer ${cfg.apiKey}` }
		};
	}
	async attemptReconnect() {
		if (this.intentionallyClosed) return;
		if (this.reconnectAttempts >= OpenAIRealtimeVoiceBridge.MAX_RECONNECT_ATTEMPTS) {
			this.config.onClose?.("error");
			return;
		}
		this.reconnectAttempts += 1;
		const delay = OpenAIRealtimeVoiceBridge.BASE_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1);
		await new Promise((resolve) => setTimeout(resolve, delay));
		if (this.intentionallyClosed) return;
		try {
			await this.doConnect();
		} catch (error) {
			this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
			await this.attemptReconnect();
		}
	}
	sendSessionUpdate() {
		this.sendEvent({
			type: "session.update",
			session: this.resolveSessionUpdatePayload()
		});
	}
	resolveSessionUpdatePayload() {
		if (this.usesAzureDeploymentRealtimeApi()) return this.resolveBetaSessionUpdatePayload();
		return this.resolveGaSessionUpdatePayload();
	}
	usesAzureDeploymentRealtimeApi() {
		return Boolean(this.config.azureEndpoint && this.config.azureDeployment);
	}
	resolveGaSessionUpdatePayload() {
		const cfg = this.config;
		const autoRespondToAudio = cfg.autoRespondToAudio ?? true;
		const interruptResponseOnInputAudio = cfg.interruptResponseOnInputAudio ?? autoRespondToAudio;
		return {
			type: "realtime",
			model: cfg.model ?? OpenAIRealtimeVoiceBridge.DEFAULT_MODEL,
			instructions: cfg.instructions,
			output_modalities: ["audio"],
			audio: {
				input: {
					format: this.resolveRealtimeAudioFormatConfig(),
					noise_reduction: { type: "near_field" },
					transcription: { model: OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL },
					turn_detection: {
						type: "server_vad",
						threshold: cfg.vadThreshold ?? .5,
						prefix_padding_ms: cfg.prefixPaddingMs ?? 300,
						silence_duration_ms: cfg.silenceDurationMs ?? 500,
						create_response: autoRespondToAudio,
						interrupt_response: interruptResponseOnInputAudio
					}
				},
				output: {
					format: this.resolveRealtimeAudioFormatConfig(),
					voice: cfg.voice ?? "alloy"
				}
			},
			...cfg.tools && cfg.tools.length > 0 ? {
				tools: cfg.tools,
				tool_choice: "auto"
			} : {}
		};
	}
	resolveBetaSessionUpdatePayload() {
		const cfg = this.config;
		return {
			modalities: ["text", "audio"],
			instructions: cfg.instructions,
			voice: cfg.voice ?? "alloy",
			input_audio_format: this.resolveRealtimeAudioFormat(),
			output_audio_format: this.resolveRealtimeAudioFormat(),
			input_audio_transcription: { model: OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL },
			turn_detection: {
				type: "server_vad",
				threshold: cfg.vadThreshold ?? .5,
				prefix_padding_ms: cfg.prefixPaddingMs ?? 300,
				silence_duration_ms: cfg.silenceDurationMs ?? 500,
				create_response: cfg.autoRespondToAudio ?? true
			},
			temperature: cfg.temperature ?? .8,
			...cfg.tools && cfg.tools.length > 0 ? {
				tools: cfg.tools,
				tool_choice: "auto"
			} : {}
		};
	}
	resolveRealtimeAudioFormatConfig() {
		return this.audioFormat.encoding === "pcm16" ? {
			type: "audio/pcm",
			rate: 24e3
		} : { type: "audio/pcmu" };
	}
	resolveRealtimeAudioFormat() {
		return this.audioFormat.encoding === "pcm16" ? "pcm16" : "g711_ulaw";
	}
	handleEvent(event) {
		this.config.onEvent?.({
			direction: "server",
			type: event.type,
			detail: this.describeServerEvent(event)
		});
		switch (event.type) {
			case "session.created": return;
			case "session.updated":
				this.sessionConfigured = true;
				for (const chunk of this.pendingAudio.splice(0)) this.sendAudio(chunk);
				if (!this.sessionReadyFired) {
					this.sessionReadyFired = true;
					this.config.onReady?.();
				}
				return;
			case "response.created":
				this.responseActive = true;
				this.responseCreateInFlight = false;
				return;
			case "response.audio.delta":
			case "response.output_audio.delta": {
				if (!event.delta) return;
				const audio = base64ToBuffer(event.delta);
				this.config.onAudio(audio);
				if (event.item_id && event.item_id !== this.lastAssistantItemId) {
					this.lastAssistantItemId = event.item_id;
					this.responseStartTimestamp = this.latestMediaTimestamp;
				} else if (this.responseStartTimestamp === null) this.responseStartTimestamp = this.latestMediaTimestamp;
				this.responseActive = true;
				this.sendMark();
				return;
			}
			case "input_audio_buffer.speech_started":
				if (this.config.autoRespondToAudio ?? true) this.handleBargeIn();
				return;
			case "response.audio_transcript.delta":
			case "response.output_audio_transcript.delta":
				if (event.delta) this.config.onTranscript?.("assistant", event.delta, false);
				return;
			case "response.audio_transcript.done":
			case "response.output_audio_transcript.done":
				if (event.transcript) this.config.onTranscript?.("assistant", event.transcript, true);
				return;
			case "conversation.item.input_audio_transcription.completed":
				if (event.transcript) this.config.onTranscript?.("user", event.transcript, true);
				return;
			case "conversation.item.input_audio_transcription.delta":
				if (event.delta) this.config.onTranscript?.("user", event.delta, false);
				return;
			case "response.cancelled":
			case "response.done":
				this.responseActive = false;
				this.responseCreateInFlight = false;
				this.responseCancelInFlight = false;
				this.flushPendingResponseCreate();
				return;
			case "response.function_call_arguments.delta": {
				const key = event.item_id ?? "unknown";
				const existing = this.toolCallBuffers.get(key);
				if (existing && event.delta) existing.args += event.delta;
				else if (event.item_id) this.toolCallBuffers.set(event.item_id, {
					name: event.name ?? "",
					callId: event.call_id ?? "",
					args: event.delta ?? ""
				});
				return;
			}
			case "response.function_call_arguments.done": {
				const key = event.item_id ?? "unknown";
				const buffered = this.toolCallBuffers.get(key);
				this.emitToolCallOnce({
					itemId: event.item_id,
					callId: buffered?.callId || event.call_id,
					name: buffered?.name || event.name,
					rawArgs: buffered?.args || event.arguments
				});
				this.toolCallBuffers.delete(key);
				return;
			}
			case "conversation.item.done":
				if (event.item?.type !== "function_call") return;
				this.emitToolCallOnce({
					itemId: event.item.id ?? event.item_id,
					callId: event.item.call_id ?? event.call_id ?? event.item.id ?? event.item_id,
					name: event.item.name ?? event.name,
					rawArgs: event.item.arguments ?? event.arguments
				});
				return;
			case "error": {
				const detail = readRealtimeErrorDetail(event.error);
				if (detail.startsWith(OPENAI_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX)) {
					this.responseActive = true;
					this.responseCreateInFlight = false;
					this.responseCreatePending = true;
					return;
				}
				if (detail === OPENAI_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR) {
					this.responseActive = false;
					this.responseCancelInFlight = false;
					this.flushPendingResponseCreate();
					return;
				}
				this.config.onError?.(new Error(detail));
				return;
			}
			default: return;
		}
	}
	handleBargeIn(options) {
		const assistantItemId = this.lastAssistantItemId;
		const responseStartTimestamp = this.responseStartTimestamp;
		const force = options?.force === true;
		const shouldInterruptProvider = assistantItemId !== null && (responseStartTimestamp !== null && (this.markQueue.length > 0 || options?.audioPlaybackActive === true) || force);
		const audioEndMs = shouldInterruptProvider ? Math.max(0, responseStartTimestamp === null ? this.latestMediaTimestamp : this.latestMediaTimestamp - responseStartTimestamp) : null;
		const minBargeInAudioEndMs = this.config.minBargeInAudioEndMs ?? OPENAI_REALTIME_DEFAULT_MIN_BARGE_IN_AUDIO_END_MS;
		if (!force && audioEndMs !== null && audioEndMs < minBargeInAudioEndMs) {
			this.config.onEvent?.({
				direction: "client",
				type: "conversation.item.truncate.skipped",
				detail: `reason=barge-in audioEndMs=${audioEndMs} minAudioEndMs=${minBargeInAudioEndMs}`
			});
			return;
		}
		if (options?.audioPlaybackActive === true && this.responseActive && !this.responseCancelInFlight) {
			this.sendEvent({ type: "response.cancel" }, "reason=barge-in");
			this.responseCancelInFlight = true;
		}
		if (shouldInterruptProvider) {
			this.sendEvent({
				type: "conversation.item.truncate",
				item_id: assistantItemId,
				content_index: 0,
				audio_end_ms: audioEndMs
			}, `reason=barge-in audioEndMs=${audioEndMs}`);
			this.config.onClearAudio();
			this.markQueue = [];
			this.lastAssistantItemId = null;
			this.responseStartTimestamp = null;
			return;
		}
		this.config.onClearAudio();
	}
	emitToolCallOnce(fields) {
		if (!this.config.onToolCall) return;
		const itemId = fields.itemId || fields.callId || "unknown";
		const callId = fields.callId || itemId;
		const name = fields.name || "";
		const dedupeKey = fields.itemId || fields.callId || `${name}:${fields.rawArgs ?? ""}`;
		if (this.deliveredToolCallKeys.has(dedupeKey)) return;
		this.deliveredToolCallKeys.add(dedupeKey);
		let args = {};
		try {
			args = JSON.parse(fields.rawArgs || "{}");
		} catch {}
		this.config.onToolCall({
			itemId,
			callId,
			name,
			args
		});
	}
	requestResponseCreate() {
		if (this.responseActive || this.responseCreateInFlight || this.responseCancelInFlight || this.continuingToolCallIds.size > 0) {
			this.responseCreatePending = true;
			return;
		}
		this.responseCreatePending = false;
		this.responseCreateInFlight = true;
		this.sendEvent({ type: "response.create" });
	}
	flushPendingResponseCreate() {
		if (!this.responseCreatePending) return;
		this.responseCreatePending = false;
		this.requestResponseCreate();
	}
	resetRealtimeSessionState() {
		this.markQueue = [];
		this.responseStartTimestamp = null;
		this.responseActive = false;
		this.responseCreateInFlight = false;
		this.responseCancelInFlight = false;
		this.responseCreatePending = false;
		this.continuingToolCallIds.clear();
		this.lastAssistantItemId = null;
		this.toolCallBuffers.clear();
		this.deliveredToolCallKeys.clear();
	}
	sendMark() {
		const markName = `audio-${Date.now()}`;
		this.markQueue.push(markName);
		this.config.onMark?.(markName);
	}
	sendEvent(event, detail) {
		if (this.ws?.readyState === WebSocket.OPEN) {
			const type = event && typeof event === "object" && typeof event.type === "string" ? event.type : "unknown";
			this.config.onEvent?.({
				direction: "client",
				type,
				...detail ? { detail } : {}
			});
			const payload = JSON.stringify(event);
			captureWsEvent({
				url: this.resolveConnectionParams().url,
				direction: "outbound",
				kind: "ws-frame",
				flowId: this.flowId,
				payload,
				meta: {
					provider: "openai",
					capability: "realtime-voice"
				}
			});
			this.ws.send(payload);
		}
	}
	describeServerEvent(event) {
		if (event.type === "error") return readRealtimeErrorDetail(event.error);
		if (event.type === "response.done") {
			const status = event.response?.status;
			const details = event.response?.status_details === void 0 ? void 0 : JSON.stringify(event.response.status_details);
			return [status ? `status=${status}` : void 0, details].filter(Boolean).join(" ") || void 0;
		}
		if (event.type === "response.cancelled") return "cancelled";
		if (event.type === "conversation.item.done" && event.item?.type) return [event.item.type, event.item.name ? `name=${event.item.name}` : void 0].filter(Boolean).join(" ");
	}
};
function readStringField(value, key) {
	if (!value || typeof value !== "object") return;
	const raw = value[key];
	return typeof raw === "string" && raw.trim() ? raw.trim() : void 0;
}
function resolveOpenAIRealtimeBrowserOfferHeaders() {
	const headers = resolveProviderRequestHeaders({
		provider: "openai",
		baseUrl: "https://api.openai.com/v1/realtime/calls",
		capability: "audio",
		transport: "http",
		defaultHeaders: {}
	});
	const SERVER_ONLY_HEADERS = new Set([
		"user-agent",
		"originator",
		"version"
	]);
	const browserHeaders = Object.fromEntries(Object.entries(headers ?? {}).filter(([key]) => !SERVER_ONLY_HEADERS.has(key.toLowerCase())));
	return Object.keys(browserHeaders).length > 0 ? browserHeaders : void 0;
}
async function createOpenAIRealtimeBrowserSession(req) {
	const config = normalizeProviderConfig(req.providerConfig);
	const apiKey = requireOpenAIRealtimeApiKey(config.apiKey);
	if (config.azureEndpoint || config.azureDeployment) throw new Error("OpenAI Realtime browser sessions do not support Azure endpoints yet");
	const model = req.model ?? config.model ?? OPENAI_REALTIME_DEFAULT_MODEL;
	const voice = req.voice ?? config.voice ?? "alloy";
	const session = {
		type: "realtime",
		model,
		instructions: req.instructions,
		audio: {
			input: {
				noise_reduction: { type: "near_field" },
				turn_detection: {
					type: "server_vad",
					create_response: true,
					interrupt_response: true
				},
				transcription: { model: OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL }
			},
			output: { voice }
		}
	};
	if (req.tools && req.tools.length > 0) {
		session.tools = req.tools;
		session.tool_choice = "auto";
	}
	const { response, release } = await fetchWithSsrFGuard({
		url: "https://api.openai.com/v1/realtime/client_secrets",
		init: {
			method: "POST",
			headers: resolveProviderRequestHeaders({
				provider: "openai",
				baseUrl: "https://api.openai.com/v1/realtime/client_secrets",
				capability: "audio",
				transport: "http",
				defaultHeaders: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json"
				}
			}) ?? {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json"
			},
			body: JSON.stringify({ session })
		},
		auditContext: "openai-realtime-browser-session"
	});
	const payload = await (async () => {
		try {
			if (!response.ok) throw await createProviderHttpError(response, "OpenAI Realtime browser session failed");
			return await response.json();
		} finally {
			await release();
		}
	})();
	const nestedSecret = payload && typeof payload === "object" ? payload.client_secret : void 0;
	const clientSecret = readStringField(payload, "value") ?? readStringField(nestedSecret, "value");
	if (!clientSecret) throw new Error("OpenAI Realtime browser session did not return a client secret");
	const expiresAt = payload && typeof payload === "object" ? payload.expires_at : void 0;
	const offerHeaders = resolveOpenAIRealtimeBrowserOfferHeaders();
	return {
		provider: "openai",
		transport: "webrtc",
		clientSecret,
		offerUrl: "https://api.openai.com/v1/realtime/calls",
		...offerHeaders ? { offerHeaders } : {},
		model,
		voice,
		...typeof expiresAt === "number" ? { expiresAt } : {}
	};
}
function buildOpenAIRealtimeVoiceProvider() {
	return {
		id: "openai",
		label: "OpenAI Realtime Voice",
		defaultModel: OPENAI_REALTIME_DEFAULT_MODEL,
		autoSelectOrder: 10,
		capabilities: {
			transports: ["webrtc", "gateway-relay"],
			inputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ, REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
			outputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ, REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
			supportsBrowserSession: true,
			supportsBargeIn: true,
			supportsToolCalls: true
		},
		resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
		isConfigured: ({ providerConfig }) => hasOpenAIRealtimeApiKeyInput(normalizeProviderConfig(providerConfig).apiKey),
		createBridge: (req) => {
			const config = normalizeProviderConfig(req.providerConfig);
			const apiKey = requireOpenAIRealtimeApiKey(config.apiKey);
			return new OpenAIRealtimeVoiceBridge({
				...req,
				apiKey,
				model: config.model,
				voice: config.voice,
				temperature: config.temperature,
				vadThreshold: config.vadThreshold,
				silenceDurationMs: config.silenceDurationMs,
				prefixPaddingMs: config.prefixPaddingMs,
				interruptResponseOnInputAudio: req.interruptResponseOnInputAudio ?? config.interruptResponseOnInputAudio,
				minBargeInAudioEndMs: config.minBargeInAudioEndMs,
				azureEndpoint: config.azureEndpoint,
				azureDeployment: config.azureDeployment,
				azureApiVersion: config.azureApiVersion
			});
		},
		createBrowserSession: createOpenAIRealtimeBrowserSession
	};
}
//#endregion
export { buildOpenAIRealtimeVoiceProvider as t };
