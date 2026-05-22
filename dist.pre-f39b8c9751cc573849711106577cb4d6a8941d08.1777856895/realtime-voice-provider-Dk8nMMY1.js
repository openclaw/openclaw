import { l as normalizeResolvedSecretInputString, u as normalizeSecretInputString } from "./types.secrets-CyuYZNvB.js";
import { c as resolveProviderRequestHeaders } from "./provider-request-config-DT1B_A_J.js";
import { n as createDebugProxyWebSocketAgent, r as resolveDebugProxySettings } from "./env-B8VzMjNy.js";
import { n as captureWsEvent } from "./runtime-DwV8HwbV.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-CE93bw39.js";
import { a as createProviderHttpError } from "./provider-http-errors-BV28ign3.js";
import "./secret-input-CBwDj35T.js";
import "./proxy-capture-BKgu1lMb.js";
import "./ssrf-runtime-Bozc6A2_.js";
import "./provider-http-CVEZetDW.js";
import { y as REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ } from "./session-runtime-WZKkWO1r.js";
import "./realtime-voice-B1VSJ5ic.js";
import { a as resolveOpenAIProviderConfigRecord, i as readRealtimeErrorDetail, o as trimToUndefined, r as captureOpenAIRealtimeWsClose, t as asFiniteNumber } from "./realtime-provider-shared-D5m43vaT.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
//#region extensions/openai/realtime-voice-provider.ts
const OPENAI_REALTIME_DEFAULT_MODEL = "gpt-realtime-1.5";
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
		azureEndpoint: trimToUndefined(raw?.azureEndpoint),
		azureDeployment: trimToUndefined(raw?.azureDeployment),
		azureApiVersion: trimToUndefined(raw?.azureApiVersion)
	};
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
		this.ws = null;
		this.connected = false;
		this.sessionConfigured = false;
		this.intentionallyClosed = false;
		this.reconnectAttempts = 0;
		this.pendingAudio = [];
		this.markQueue = [];
		this.responseStartTimestamp = null;
		this.responseActive = false;
		this.latestMediaTimestamp = 0;
		this.lastAssistantItemId = null;
		this.toolCallBuffers = /* @__PURE__ */ new Map();
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
		this.sendEvent({ type: "response.create" });
	}
	triggerGreeting(instructions) {
		if (!this.isConnected() || !this.ws) return;
		this.sendEvent({
			type: "response.create",
			response: { instructions: instructions ?? this.config.instructions }
		});
	}
	submitToolResult(callId, result) {
		this.sendEvent({
			type: "conversation.item.create",
			item: {
				type: "function_call_output",
				call_id: callId,
				output: JSON.stringify(result)
			}
		});
		this.sendEvent({ type: "response.create" });
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
				if (!this.connected && !this.intentionallyClosed) {
					this.ws?.terminate();
					settleReject(/* @__PURE__ */ new Error("OpenAI realtime connection timeout"));
				}
			}, OpenAIRealtimeVoiceBridge.CONNECT_TIMEOUT_MS);
			this.ws.on("open", () => {
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
				settleResolve();
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
					this.handleEvent(JSON.parse(data.toString()));
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
				if (!this.connected) settleReject(error instanceof Error ? error : new Error(String(error)));
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
				defaultHeaders: {
					Authorization: `Bearer ${cfg.apiKey}`,
					"OpenAI-Beta": "realtime=v1"
				}
			}) ?? {
				Authorization: `Bearer ${cfg.apiKey}`,
				"OpenAI-Beta": "realtime=v1"
			}
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
		const cfg = this.config;
		const sessionUpdate = {
			type: "session.update",
			session: {
				modalities: ["text", "audio"],
				instructions: cfg.instructions,
				voice: cfg.voice ?? "alloy",
				input_audio_format: this.resolveRealtimeAudioFormat(),
				output_audio_format: this.resolveRealtimeAudioFormat(),
				input_audio_transcription: { model: "whisper-1" },
				turn_detection: {
					type: "server_vad",
					threshold: cfg.vadThreshold ?? .5,
					prefix_padding_ms: cfg.prefixPaddingMs ?? 300,
					silence_duration_ms: cfg.silenceDurationMs ?? 500,
					create_response: true
				},
				temperature: cfg.temperature ?? .8,
				...cfg.tools && cfg.tools.length > 0 ? {
					tools: cfg.tools,
					tool_choice: "auto"
				} : {}
			}
		};
		this.sendEvent(sessionUpdate);
	}
	resolveRealtimeAudioFormat() {
		return this.audioFormat.encoding === "pcm16" ? "pcm16" : "g711_ulaw";
	}
	handleEvent(event) {
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
				return;
			case "response.audio.delta": {
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
				this.handleBargeIn();
				return;
			case "response.audio_transcript.delta":
				if (event.delta) this.config.onTranscript?.("assistant", event.delta, false);
				return;
			case "response.audio_transcript.done":
				if (event.transcript) this.config.onTranscript?.("assistant", event.transcript, true);
				return;
			case "conversation.item.input_audio_transcription.completed":
				if (event.transcript) this.config.onTranscript?.("user", event.transcript, true);
				return;
			case "conversation.item.input_audio_transcription.delta":
				if (event.delta) this.config.onTranscript?.("user", event.delta, false);
				return;
			case "response.done":
				this.responseActive = false;
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
				if (this.config.onToolCall) {
					const rawArgs = buffered?.args || event.arguments || "{}";
					let args = {};
					try {
						args = JSON.parse(rawArgs);
					} catch {}
					this.config.onToolCall({
						itemId: key,
						callId: buffered?.callId || event.call_id || "",
						name: buffered?.name || event.name || "",
						args
					});
				}
				this.toolCallBuffers.delete(key);
				return;
			}
			case "error": {
				const detail = readRealtimeErrorDetail(event.error);
				this.config.onError?.(new Error(detail));
				return;
			}
			default: return;
		}
	}
	handleBargeIn(options) {
		const assistantItemId = this.lastAssistantItemId;
		const responseStartTimestamp = this.responseStartTimestamp;
		const shouldInterruptProvider = responseStartTimestamp !== null && assistantItemId !== null && (this.markQueue.length > 0 || options?.audioPlaybackActive === true);
		if (options?.audioPlaybackActive === true && this.responseActive) this.sendEvent({ type: "response.cancel" });
		if (shouldInterruptProvider) {
			const elapsedMs = this.latestMediaTimestamp - responseStartTimestamp;
			this.sendEvent({
				type: "conversation.item.truncate",
				item_id: assistantItemId,
				content_index: 0,
				audio_end_ms: Math.max(0, elapsedMs)
			});
			this.config.onClearAudio();
			this.markQueue = [];
			this.lastAssistantItemId = null;
			this.responseStartTimestamp = null;
			this.responseActive = false;
			return;
		}
		this.config.onClearAudio();
	}
	sendMark() {
		const markName = `audio-${Date.now()}`;
		this.markQueue.push(markName);
		this.config.onMark?.(markName);
	}
	sendEvent(event) {
		if (this.ws?.readyState === WebSocket.OPEN) {
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
	const browserHeaders = Object.fromEntries(Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() !== "user-agent"));
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
				turn_detection: {
					type: "server_vad",
					create_response: true,
					interrupt_response: true
				},
				transcription: { model: "whisper-1" }
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
		transport: "webrtc-sdp",
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
		autoSelectOrder: 10,
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
