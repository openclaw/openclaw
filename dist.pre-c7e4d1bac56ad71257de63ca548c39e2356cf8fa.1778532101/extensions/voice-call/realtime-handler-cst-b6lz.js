import { i as formatErrorMessage } from "../../errors-QN8rySzW.js";
import "../../error-runtime-RY0qqoh6.js";
import { f as buildRealtimeVoiceAgentConsultWorkingResponse, t as createRealtimeVoiceBridgeSession } from "../../session-runtime-uu8ar2X7.js";
import "../../realtime-voice-BFP6Gtks.js";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
//#region extensions/voice-call/src/webhook/realtime-audio-pacer.ts
const TELEPHONY_SAMPLE_RATE = 8e3;
const TELEPHONY_CHUNK_BYTES = 160;
const TELEPHONY_CHUNK_MS = 20;
const DEFAULT_SPEECH_RMS_THRESHOLD = .02;
const DEFAULT_REQUIRED_LOUD_CHUNKS = 2;
const DEFAULT_REQUIRED_QUIET_CHUNKS = 10;
const DEFAULT_MAX_QUEUED_AUDIO_BYTES = TELEPHONY_SAMPLE_RATE * 120;
const PCM16_MAX_AMPLITUDE = 32768;
const MULAW_LINEAR_SAMPLES = new Int16Array(256);
for (let i = 0; i < MULAW_LINEAR_SAMPLES.length; i += 1) MULAW_LINEAR_SAMPLES[i] = decodeMulawSample(i);
var RealtimeTwilioAudioPacer = class {
	constructor(params) {
		this.params = params;
		this.queue = [];
		this.timer = null;
		this.queuedAudioBytes = 0;
		this.closed = false;
	}
	sendAudio(muLaw) {
		if (this.closed || muLaw.length === 0) return;
		const maxQueuedAudioBytes = this.params.maxQueuedAudioBytes ?? DEFAULT_MAX_QUEUED_AUDIO_BYTES;
		for (let offset = 0; offset < muLaw.length; offset += TELEPHONY_CHUNK_BYTES) {
			const chunk = Buffer.from(muLaw.subarray(offset, offset + TELEPHONY_CHUNK_BYTES));
			if (this.queuedAudioBytes + chunk.length > maxQueuedAudioBytes) {
				this.failBackpressure();
				return;
			}
			this.queue.push({
				type: "audio",
				chunk,
				durationMs: Math.max(1, Math.round(chunk.length / TELEPHONY_SAMPLE_RATE * 1e3))
			});
			this.queuedAudioBytes += chunk.length;
		}
		this.ensurePump();
	}
	sendMark(name) {
		if (this.closed || !name) return;
		this.queue.push({
			type: "mark",
			name
		});
		this.ensurePump();
	}
	clearAudio() {
		if (this.closed) return;
		this.clearTimer();
		this.queue = [];
		this.queuedAudioBytes = 0;
		this.params.sendJson({
			event: "clear",
			streamSid: this.params.streamSid
		});
	}
	close() {
		this.closed = true;
		this.clearTimer();
		this.queue = [];
		this.queuedAudioBytes = 0;
	}
	clearTimer() {
		if (!this.timer) return;
		clearTimeout(this.timer);
		this.timer = null;
	}
	ensurePump() {
		if (!this.timer) this.pump();
	}
	failBackpressure() {
		this.close();
		this.params.onBackpressure?.();
	}
	pump() {
		this.timer = null;
		if (this.closed) return;
		const item = this.queue.shift();
		if (!item) return;
		let delayMs = 0;
		let sent = true;
		if (item.type === "audio") {
			this.queuedAudioBytes = Math.max(0, this.queuedAudioBytes - item.chunk.length);
			sent = this.params.sendJson({
				event: "media",
				streamSid: this.params.streamSid,
				media: { payload: item.chunk.toString("base64") }
			});
			delayMs = item.durationMs || TELEPHONY_CHUNK_MS;
		} else sent = this.params.sendJson({
			event: "mark",
			streamSid: this.params.streamSid,
			mark: { name: item.name }
		});
		if (!sent) {
			this.queue = [];
			this.queuedAudioBytes = 0;
			return;
		}
		if (this.queue.length > 0) this.timer = setTimeout(() => this.pump(), delayMs);
	}
};
function calculateMulawRms(muLaw) {
	if (muLaw.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < muLaw.length; i += 1) {
		const normalized = (MULAW_LINEAR_SAMPLES[muLaw[i] ?? 0] ?? 0) / PCM16_MAX_AMPLITUDE;
		sum += normalized * normalized;
	}
	return Math.sqrt(sum / muLaw.length);
}
var RealtimeMulawSpeechStartDetector = class {
	constructor(params = {}) {
		this.params = params;
		this.loudChunks = 0;
		this.quietChunks = DEFAULT_REQUIRED_QUIET_CHUNKS;
		this.speaking = false;
	}
	accept(muLaw) {
		if (calculateMulawRms(muLaw) >= (this.params.rmsThreshold ?? DEFAULT_SPEECH_RMS_THRESHOLD)) {
			this.quietChunks = 0;
			this.loudChunks += 1;
			const requiredLoudChunks = this.params.requiredLoudChunks ?? DEFAULT_REQUIRED_LOUD_CHUNKS;
			if (!this.speaking && this.loudChunks >= requiredLoudChunks) {
				this.speaking = true;
				return true;
			}
			return false;
		}
		this.loudChunks = 0;
		this.quietChunks += 1;
		const requiredQuietChunks = this.params.requiredQuietChunks ?? DEFAULT_REQUIRED_QUIET_CHUNKS;
		if (this.quietChunks >= requiredQuietChunks) this.speaking = false;
		return false;
	}
};
function decodeMulawSample(value) {
	const muLaw = ~value & 255;
	const sign = muLaw & 128;
	const exponent = muLaw >> 4 & 7;
	let sample = ((muLaw & 15) << 3) + 132 << exponent;
	sample -= 132;
	return sign ? -sample : sample;
}
//#endregion
//#region extensions/voice-call/src/webhook/realtime-handler.ts
const STREAM_TOKEN_TTL_MS = 3e4;
const DEFAULT_HOST = "localhost:8443";
const MAX_REALTIME_MESSAGE_BYTES = 256 * 1024;
const MAX_REALTIME_WS_BUFFERED_BYTES = 1024 * 1024;
function normalizePath(pathname) {
	const trimmed = pathname.trim();
	if (!trimmed) return "/";
	const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	if (prefixed === "/") return prefixed;
	return prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
}
function buildGreetingInstructions(baseInstructions, greeting) {
	const trimmedGreeting = greeting?.trim();
	if (!trimmedGreeting) return;
	const intro = "Start the call by greeting the caller naturally. Include this greeting in your first spoken reply:";
	return baseInstructions ? `${baseInstructions}\n\n${intro} "${trimmedGreeting}"` : `${intro} "${trimmedGreeting}"`;
}
var RealtimeCallHandler = class {
	constructor(config, manager, provider, realtimeProvider, providerConfig, servePath) {
		this.config = config;
		this.manager = manager;
		this.provider = provider;
		this.realtimeProvider = realtimeProvider;
		this.providerConfig = providerConfig;
		this.servePath = servePath;
		this.toolHandlers = /* @__PURE__ */ new Map();
		this.pendingStreamTokens = /* @__PURE__ */ new Map();
		this.activeBridgesByCallId = /* @__PURE__ */ new Map();
		this.partialUserTranscriptsByCallId = /* @__PURE__ */ new Map();
		this.publicOrigin = null;
		this.publicPathPrefix = "";
	}
	setPublicUrl(url) {
		try {
			const parsed = new URL(url);
			this.publicOrigin = parsed.host;
			const normalizedServePath = normalizePath(this.servePath);
			const normalizedPublicPath = normalizePath(parsed.pathname);
			const idx = normalizedPublicPath.indexOf(normalizedServePath);
			this.publicPathPrefix = idx > 0 ? normalizedPublicPath.slice(0, idx) : "";
		} catch {
			this.publicOrigin = null;
			this.publicPathPrefix = "";
		}
	}
	getStreamPathPattern() {
		return `${this.publicPathPrefix}${normalizePath(this.config.streamPath ?? "/voice/stream/realtime")}`;
	}
	buildTwiMLPayload(req, params) {
		const host = this.publicOrigin || req.headers.host || DEFAULT_HOST;
		const rawDirection = params?.get("Direction");
		const token = this.issueStreamToken({
			from: params?.get("From") ?? void 0,
			to: params?.get("To") ?? void 0,
			direction: rawDirection?.startsWith("outbound") ? "outbound" : "inbound"
		});
		return {
			statusCode: 200,
			headers: { "Content-Type": "text/xml" },
			body: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${`wss://${host}${this.getStreamPathPattern()}/${token}`}" />
  </Connect>
</Response>`
		};
	}
	handleWebSocketUpgrade(request, socket, head) {
		const token = new URL(request.url ?? "/", "wss://localhost").pathname.split("/").pop() ?? null;
		const callerMeta = token ? this.consumeStreamToken(token) : null;
		if (!callerMeta) {
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			socket.destroy();
			return;
		}
		new WebSocketServer({
			noServer: true,
			maxPayload: MAX_REALTIME_MESSAGE_BYTES
		}).handleUpgrade(request, socket, head, (ws) => {
			let bridge = null;
			let initialized = false;
			ws.on("message", (data) => {
				try {
					const msg = JSON.parse(data.toString());
					if (!initialized && msg.event === "start") {
						initialized = true;
						const startData = typeof msg.start === "object" && msg.start !== null ? msg.start : void 0;
						const streamSid = typeof startData?.streamSid === "string" ? startData.streamSid : "unknown";
						const callSid = typeof startData?.callSid === "string" ? startData.callSid : "unknown";
						const nextBridge = this.handleCall(streamSid, callSid, ws, callerMeta);
						if (!nextBridge) return;
						bridge = nextBridge;
						return;
					}
					if (!bridge) return;
					const mediaData = typeof msg.media === "object" && msg.media !== null ? msg.media : void 0;
					if (msg.event === "media" && typeof mediaData?.payload === "string") {
						const audio = Buffer.from(mediaData.payload, "base64");
						bridge.sendAudio(audio);
						if (typeof mediaData.timestamp === "number") bridge.setMediaTimestamp(mediaData.timestamp);
						else if (typeof mediaData.timestamp === "string") bridge.setMediaTimestamp(Number.parseInt(mediaData.timestamp, 10));
						return;
					}
					if (msg.event === "mark") {
						bridge.acknowledgeMark();
						return;
					}
					if (msg.event === "stop") bridge.close();
				} catch (error) {
					console.error("[voice-call] realtime WS parse failed:", error);
				}
			});
			ws.on("close", () => {
				bridge?.close();
			});
			ws.on("error", (error) => {
				console.error("[voice-call] realtime WS error:", error);
			});
		});
	}
	registerToolHandler(name, fn) {
		this.toolHandlers.set(name, fn);
	}
	speak(callId, instructions) {
		const bridge = this.activeBridgesByCallId.get(callId);
		if (!bridge) return {
			success: false,
			error: "No active realtime bridge for call"
		};
		try {
			bridge.triggerGreeting(instructions);
			return { success: true };
		} catch (error) {
			return {
				success: false,
				error: formatErrorMessage(error)
			};
		}
	}
	issueStreamToken(meta = {}) {
		const token = randomUUID();
		this.pendingStreamTokens.set(token, {
			expiry: Date.now() + STREAM_TOKEN_TTL_MS,
			...meta
		});
		for (const [candidate, entry] of this.pendingStreamTokens) if (Date.now() > entry.expiry) this.pendingStreamTokens.delete(candidate);
		return token;
	}
	consumeStreamToken(token) {
		const entry = this.pendingStreamTokens.get(token);
		if (!entry) return null;
		this.pendingStreamTokens.delete(token);
		if (Date.now() > entry.expiry) return null;
		return {
			from: entry.from,
			to: entry.to,
			direction: entry.direction
		};
	}
	handleCall(streamSid, callSid, ws, callerMeta) {
		const registration = this.registerCallInManager(callSid, callerMeta);
		if (!registration) {
			ws.close(1008, "Caller rejected by policy");
			return null;
		}
		const { callId, initialGreetingInstructions } = registration;
		console.log(`[voice-call] Realtime bridge starting for call ${callId} (providerCallId=${callSid}, initialGreeting=${initialGreetingInstructions ? "queued" : "absent"})`);
		let callEndEmitted = false;
		const emitCallEnd = (reason) => {
			if (callEndEmitted) return;
			callEndEmitted = true;
			this.endCallInManager(callSid, callId, reason);
		};
		const sendJson = (message) => {
			if (ws.readyState !== WebSocket.OPEN) return false;
			if (ws.bufferedAmount > MAX_REALTIME_WS_BUFFERED_BYTES) {
				ws.close(1013, "Backpressure: send buffer exceeded");
				return false;
			}
			ws.send(JSON.stringify(message));
			if (ws.bufferedAmount > MAX_REALTIME_WS_BUFFERED_BYTES) {
				ws.close(1013, "Backpressure: send buffer exceeded");
				return false;
			}
			return true;
		};
		const audioPacer = new RealtimeTwilioAudioPacer({
			streamSid,
			sendJson,
			onBackpressure: () => {
				if (ws.readyState === WebSocket.OPEN) ws.close(1013, "Backpressure: paced audio queue exceeded");
			}
		});
		const speechDetector = new RealtimeMulawSpeechStartDetector();
		const session = createRealtimeVoiceBridgeSession({
			provider: this.realtimeProvider,
			providerConfig: this.providerConfig,
			instructions: this.config.instructions,
			tools: this.config.tools,
			initialGreetingInstructions,
			triggerGreetingOnReady: Boolean(initialGreetingInstructions),
			audioSink: {
				isOpen: () => ws.readyState === WebSocket.OPEN,
				sendAudio: (muLaw) => {
					audioPacer.sendAudio(muLaw);
				},
				clearAudio: () => {
					audioPacer.clearAudio();
				},
				sendMark: (markName) => {
					audioPacer.sendMark(markName);
				}
			},
			onTranscript: (role, text, isFinal) => {
				if (!isFinal) {
					if (role === "user" && text.trim()) this.partialUserTranscriptsByCallId.set(callId, text);
					return;
				}
				if (role === "user") {
					this.partialUserTranscriptsByCallId.delete(callId);
					const event = {
						id: `realtime-speech-${callSid}-${Date.now()}`,
						type: "call.speech",
						callId,
						providerCallId: callSid,
						timestamp: Date.now(),
						transcript: text,
						isFinal: true
					};
					this.manager.processEvent(event);
					return;
				}
				this.manager.processEvent({
					id: `realtime-bot-${callSid}-${Date.now()}`,
					type: "call.speaking",
					callId,
					providerCallId: callSid,
					timestamp: Date.now(),
					text
				});
			},
			onToolCall: (toolEvent, session) => {
				this.executeToolCall(session, callId, toolEvent.callId || toolEvent.itemId, toolEvent.name, toolEvent.args);
			},
			onError: (error) => {
				console.error("[voice-call] realtime voice error:", error.message);
			},
			onClose: (reason) => {
				this.activeBridgesByCallId.delete(callId);
				this.activeBridgesByCallId.delete(callSid);
				this.partialUserTranscriptsByCallId.delete(callId);
				if (reason !== "error") {
					emitCallEnd("completed");
					return;
				}
				emitCallEnd("error");
				if (ws.readyState === WebSocket.OPEN) ws.close(1011, "Bridge disconnected");
				this.provider.hangupCall({
					callId,
					providerCallId: callSid,
					reason: "error"
				}).catch((error) => {
					console.warn(`[voice-call] Failed to hang up realtime call ${callSid}: ${formatErrorMessage(error)}`);
				});
			}
		});
		this.activeBridgesByCallId.set(callId, session);
		this.activeBridgesByCallId.set(callSid, session);
		const sendAudioToSession = session.sendAudio.bind(session);
		session.sendAudio = (audio) => {
			if (speechDetector.accept(audio)) audioPacer.clearAudio();
			sendAudioToSession(audio);
		};
		const closeSession = session.close.bind(session);
		session.close = () => {
			this.activeBridgesByCallId.delete(callId);
			this.activeBridgesByCallId.delete(callSid);
			this.partialUserTranscriptsByCallId.delete(callId);
			audioPacer.close();
			closeSession();
		};
		session.connect().catch((error) => {
			console.error("[voice-call] Failed to connect realtime bridge:", error);
			session.close();
			emitCallEnd("error");
			ws.close(1011, "Failed to connect");
		});
		return session;
	}
	registerCallInManager(callSid, callerMeta = {}) {
		const baseFields = {
			providerCallId: callSid,
			timestamp: Date.now(),
			direction: callerMeta.direction ?? "inbound",
			...callerMeta.from ? { from: callerMeta.from } : {},
			...callerMeta.to ? { to: callerMeta.to } : {}
		};
		this.manager.processEvent({
			id: `realtime-initiated-${callSid}`,
			callId: callSid,
			type: "call.initiated",
			...baseFields
		});
		const callRecord = this.manager.getCallByProviderCallId(callSid);
		if (!callRecord) return null;
		const initialGreeting = this.extractInitialGreeting(callRecord);
		console.log(`[voice-call] Realtime call ${callRecord.callId} initial greeting ${initialGreeting ? "queued" : "absent"}`);
		if (callRecord.metadata) delete callRecord.metadata.initialMessage;
		this.manager.processEvent({
			id: `realtime-answered-${callSid}`,
			callId: callSid,
			type: "call.answered",
			...baseFields
		});
		return {
			callId: callRecord.callId,
			initialGreetingInstructions: buildGreetingInstructions(this.config.instructions, initialGreeting)
		};
	}
	extractInitialGreeting(call) {
		return typeof call.metadata?.initialMessage === "string" ? call.metadata.initialMessage : void 0;
	}
	endCallInManager(callSid, callId, reason) {
		this.manager.processEvent({
			id: `realtime-ended-${callSid}-${Date.now()}`,
			type: "call.ended",
			callId,
			providerCallId: callSid,
			timestamp: Date.now(),
			reason
		});
	}
	async executeToolCall(bridge, callId, bridgeCallId, name, args) {
		const handler = this.toolHandlers.get(name);
		if (handler && name === "openclaw_agent_consult" && bridge.bridge.supportsToolResultContinuation && !this.config.fastContext.enabled) bridge.submitToolResult(bridgeCallId, buildRealtimeVoiceAgentConsultWorkingResponse("caller"), { willContinue: true });
		const result = !handler ? { error: `Tool "${name}" not available` } : await handler(args, callId, { partialUserTranscript: this.partialUserTranscriptsByCallId.get(callId) }).catch((error) => ({ error: formatErrorMessage(error) }));
		bridge.submitToolResult(bridgeCallId, result);
	}
};
//#endregion
export { RealtimeCallHandler };
