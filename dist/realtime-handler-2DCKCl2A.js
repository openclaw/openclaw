import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import "./error-runtime-BnVeBNYa.js";
import { S as recordTalkObservabilityEvent, b as createTalkSessionController, c as REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, p as buildRealtimeVoiceAgentConsultWorkingResponse, t as createRealtimeVoiceBridgeSession } from "./session-runtime-CA9Yhu5F.js";
import "./realtime-voice-m-eI7iVp.js";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
//#region extensions/voice-call/src/webhook/realtime-audio-pacer.ts
const TELEPHONY_SAMPLE_RATE = 8e3;
const TELEPHONY_CHUNK_BYTES = 160;
const TELEPHONY_CHUNK_MS = 20;
const DEFAULT_SPEECH_RMS_THRESHOLD = .035;
const DEFAULT_REQUIRED_LOUD_CHUNKS = 4;
const DEFAULT_REQUIRED_QUIET_CHUNKS = 12;
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
		if (this.closed) return 0;
		const clearedAudioBytes = this.queuedAudioBytes;
		this.clearTimer();
		this.queue = [];
		this.queuedAudioBytes = 0;
		this.params.sendJson({
			event: "clear",
			streamSid: this.params.streamSid
		});
		return clearedAudioBytes;
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
const FORCED_CONSULT_FALLBACK_DELAY_MS = 200;
const FORCED_CONSULT_NATIVE_DEDUPE_MS = 2e3;
const FORCED_CONSULT_RESULT_MAX_CHARS = 1800;
const CONSULT_TRANSCRIPT_SETTLE_MS = 350;
const CONSULT_TRANSCRIPT_SETTLE_MAX_MS = 1e3;
const MAX_PARTIAL_USER_TRANSCRIPT_CHARS = 1200;
const RECENT_FINAL_USER_TRANSCRIPT_TTL_MS = 2e3;
const BARGE_IN_REQUIRED_LOUD_CHUNKS = 2;
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
function readSpeakableToolResultText(result) {
	if (typeof result === "string") return result.trim() || void 0;
	if (!result || typeof result !== "object" || Array.isArray(result)) return;
	const text = result.text;
	if (typeof text === "string" && text.trim()) return text.trim();
	const output = result.output;
	return typeof output === "string" && output.trim() ? output.trim() : void 0;
}
function readConsultArgText(args, key) {
	if (!args || typeof args !== "object" || Array.isArray(args)) return;
	const value = args[key];
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function readConsultQuestionText(args) {
	return readConsultArgText(args, "question") ?? readConsultArgText(args, "prompt") ?? readConsultArgText(args, "query") ?? readConsultArgText(args, "task");
}
function normalizeTranscriptText(text) {
	return text.replace(/\s+/g, " ").trim();
}
function findTextOverlap(base, next) {
	const max = Math.min(base.length, next.length);
	for (let size = max; size > 0; size -= 1) if (base.slice(-size) === next.slice(0, size)) return size;
	return 0;
}
function shouldInsertTranscriptSpace(base, next) {
	if (!base || !next) return false;
	const last = base.at(-1);
	if (/\s$/.test(base) || last === "(" || last === "[" || last === "{" || last === "\"" || last === "'" || /^[\s,.;:!?)]/.test(next)) return false;
	return true;
}
function appendTranscriptText(base, fragment) {
	const next = normalizeTranscriptText(fragment);
	if (!next) return base ?? "";
	const current = normalizeTranscriptText(base ?? "");
	if (!current) return next;
	const currentLower = current.toLowerCase();
	const nextLower = next.toLowerCase();
	if (currentLower === nextLower || currentLower.endsWith(nextLower)) return current;
	if (nextLower.startsWith(currentLower)) return next;
	const overlap = findTextOverlap(currentLower, nextLower);
	if (overlap >= 6 || overlap >= 3 && next.length <= 12) return `${current}${next.slice(overlap)}`.trim();
	return `${current}${shouldInsertTranscriptSpace(current, next) ? " " : ""}${next}`.trim();
}
function limitPartialUserTranscript(text) {
	if (text.length <= MAX_PARTIAL_USER_TRANSCRIPT_CHARS) return text;
	const tail = text.slice(-MAX_PARTIAL_USER_TRANSCRIPT_CHARS);
	return tail.replace(/^\S+\s+/, "").trimStart() || tail.trimStart();
}
function withFallbackConsultQuestion(args, fallback) {
	const providerQuestion = readConsultQuestionText(args);
	const question = fallback?.trim();
	if (providerQuestion) {
		if (question && providerQuestion.length <= 40 && question.length >= providerQuestion.length + 8) {
			const context = readConsultArgText(args, "context");
			const fallbackContext = `Realtime provider supplied a shorter consult question: ${providerQuestion}`;
			return args && typeof args === "object" && !Array.isArray(args) ? {
				...args,
				question,
				context: context ? `${context}\n\n${fallbackContext}` : fallbackContext
			} : {
				question,
				context: fallbackContext
			};
		}
		return args;
	}
	if (!question) return args;
	return args && typeof args === "object" && !Array.isArray(args) ? {
		...args,
		question
	} : { question };
}
function buildForcedConsultSpeechPrompt(result) {
	const trimmed = result.trim();
	return [
		"Internal OpenClaw consult result is ready.",
		"Do not call tools for this internal result.",
		"Speak the following answer to the caller now, briefly and naturally:",
		trimmed.length <= FORCED_CONSULT_RESULT_MAX_CHARS ? trimmed : `${trimmed.slice(0, FORCED_CONSULT_RESULT_MAX_CHARS - 16).trimEnd()} [truncated]`
	].join("\n");
}
function appendRecentTalkEventMetadata(call, event) {
	if (!call) return;
	const metadata = call.metadata ?? {};
	const previous = Array.isArray(metadata.recentTalkEvents) ? metadata.recentTalkEvents : [];
	metadata.lastTalkEventAt = event.timestamp;
	metadata.lastTalkEventType = event.type;
	metadata.recentTalkEvents = [...previous, {
		id: event.id,
		brain: event.brain,
		mode: event.mode,
		provider: event.provider,
		seq: event.seq,
		sessionId: event.sessionId,
		timestamp: event.timestamp,
		transport: event.transport,
		type: event.type,
		...event.turnId ? { turnId: event.turnId } : {},
		...event.final !== void 0 ? { final: event.final } : {}
	}].slice(-12);
	call.metadata = metadata;
}
var RealtimeCallHandler = class {
	constructor(config, manager, provider, realtimeProvider, providerConfig, servePath, coreConfig) {
		this.config = config;
		this.manager = manager;
		this.provider = provider;
		this.realtimeProvider = realtimeProvider;
		this.providerConfig = providerConfig;
		this.servePath = servePath;
		this.coreConfig = coreConfig;
		this.toolHandlers = /* @__PURE__ */ new Map();
		this.pendingStreamTokens = /* @__PURE__ */ new Map();
		this.activeBridgesByCallId = /* @__PURE__ */ new Map();
		this.activeTelephonyClosersByCallId = /* @__PURE__ */ new Map();
		this.partialUserTranscriptsByCallId = /* @__PURE__ */ new Map();
		this.partialUserTranscriptUpdatedAtByCallId = /* @__PURE__ */ new Map();
		this.recentFinalUserTranscriptsByCallId = /* @__PURE__ */ new Map();
		this.recentFinalUserTranscriptTimersByCallId = /* @__PURE__ */ new Map();
		this.forcedConsultTimersByCallId = /* @__PURE__ */ new Map();
		this.forcedConsultInFlightByCallId = /* @__PURE__ */ new Set();
		this.forcedConsultsByCallId = /* @__PURE__ */ new Map();
		this.lastProviderConsultAtByCallId = /* @__PURE__ */ new Map();
		this.nativeConsultsInFlightByCallId = /* @__PURE__ */ new Map();
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
			let activeCallSid = "unknown";
			let stopReceived = false;
			let lastMediaTimestamp;
			let lastMediaGapWarnAt = 0;
			ws.on("message", (data) => {
				try {
					const msg = JSON.parse(data.toString());
					if (!initialized && msg.event === "start") {
						initialized = true;
						const startData = typeof msg.start === "object" && msg.start !== null ? msg.start : void 0;
						const streamSid = typeof startData?.streamSid === "string" ? startData.streamSid : "unknown";
						const callSid = typeof startData?.callSid === "string" ? startData.callSid : "unknown";
						activeCallSid = callSid;
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
						const mediaTimestamp = typeof mediaData.timestamp === "number" ? mediaData.timestamp : typeof mediaData.timestamp === "string" ? Number.parseInt(mediaData.timestamp, 10) : NaN;
						if (Number.isFinite(mediaTimestamp)) {
							if (lastMediaTimestamp !== void 0) {
								const gapMs = mediaTimestamp - lastMediaTimestamp;
								const now = Date.now();
								if ((gapMs > 120 || gapMs < 0) && now - lastMediaGapWarnAt > 5e3) {
									lastMediaGapWarnAt = now;
									console.warn(`[voice-call] realtime media timestamp gap providerCallId=${activeCallSid} gapMs=${gapMs} timestamp=${mediaTimestamp}`);
								}
							}
							lastMediaTimestamp = mediaTimestamp;
							bridge.setMediaTimestamp(mediaTimestamp);
						}
						return;
					}
					if (msg.event === "mark") {
						bridge.acknowledgeMark();
						return;
					}
					if (msg.event === "stop") {
						stopReceived = true;
						this.closeTelephonyBridge(activeCallSid, bridge, "completed");
					}
				} catch (error) {
					console.error("[voice-call] realtime WS parse failed:", error);
				}
			});
			ws.on("close", (code) => {
				const reason = stopReceived || code === 1e3 || code === 1005 ? "completed" : "error";
				this.closeTelephonyBridge(activeCallSid, bridge, reason);
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
		const callRecord = this.manager.getCallByProviderCallId(callSid);
		const talk = createTalkSessionController({
			sessionId: `voice-call:${callId}:realtime`,
			mode: "realtime",
			transport: "gateway-relay",
			brain: "agent-consult",
			provider: this.realtimeProvider.id
		}, { onEvent: recordTalkObservabilityEvent });
		const rememberTalkEvent = (event) => {
			if (event) appendRecentTalkEventMetadata(callRecord, event);
			return event;
		};
		const emitTalkEvent = (input) => {
			return rememberTalkEvent(talk.emit(input));
		};
		const ensureTalkTurn = () => {
			const turn = talk.ensureTurn({ payload: {
				callId,
				providerCallId: callSid
			} });
			rememberTalkEvent(turn.event);
			return turn.turnId;
		};
		const endTalkTurn = (reason = "completed") => {
			const ended = talk.endTurn({ payload: {
				callId,
				providerCallId: callSid,
				reason
			} });
			if (ended.ok) rememberTalkEvent(ended.event);
		};
		const finishOutputAudio = (reason) => {
			rememberTalkEvent(talk.finishOutputAudio({ payload: {
				callId,
				providerCallId: callSid,
				reason
			} }));
		};
		emitTalkEvent({
			type: "session.started",
			payload: {
				callId,
				providerCallId: callSid,
				streamSid
			}
		});
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
				console.warn(`[voice-call] realtime outbound websocket backpressure before send callId=${callId} providerCallId=${callSid} bufferedBytes=${ws.bufferedAmount}`);
				ws.close(1013, "Backpressure: send buffer exceeded");
				return false;
			}
			ws.send(JSON.stringify(message));
			if (ws.bufferedAmount > MAX_REALTIME_WS_BUFFERED_BYTES) {
				console.warn(`[voice-call] realtime outbound websocket backpressure after send callId=${callId} providerCallId=${callSid} bufferedBytes=${ws.bufferedAmount}`);
				ws.close(1013, "Backpressure: send buffer exceeded");
				return false;
			}
			return true;
		};
		const audioPacer = new RealtimeTwilioAudioPacer({
			streamSid,
			sendJson,
			onBackpressure: () => {
				console.warn(`[voice-call] realtime paced audio backpressure callId=${callId} providerCallId=${callSid}`);
				if (ws.readyState === WebSocket.OPEN) ws.close(1013, "Backpressure: paced audio queue exceeded");
			}
		});
		const speechDetector = new RealtimeMulawSpeechStartDetector({ requiredLoudChunks: BARGE_IN_REQUIRED_LOUD_CHUNKS });
		const session = createRealtimeVoiceBridgeSession({
			provider: this.realtimeProvider,
			cfg: this.coreConfig,
			providerConfig: this.providerConfig,
			instructions: this.config.instructions,
			tools: this.config.tools,
			initialGreetingInstructions,
			triggerGreetingOnReady: Boolean(initialGreetingInstructions),
			audioSink: {
				isOpen: () => ws.readyState === WebSocket.OPEN,
				sendAudio: (muLaw) => {
					const turnId = ensureTalkTurn();
					rememberTalkEvent(talk.startOutputAudio({
						turnId,
						payload: {
							callId,
							providerCallId: callSid
						}
					}).event);
					emitTalkEvent({
						type: "output.audio.delta",
						turnId,
						payload: { byteLength: muLaw.length }
					});
					audioPacer.sendAudio(muLaw);
				},
				clearAudio: () => {
					const clearedBytes = audioPacer.clearAudio();
					console.log(`[voice-call] realtime outbound audio clear requested callId=${callId} providerCallId=${callSid} queuedBytes=${clearedBytes}`);
					finishOutputAudio("clear");
				},
				sendMark: (markName) => {
					audioPacer.sendMark(markName);
				}
			},
			onTranscript: (role, text, isFinal) => {
				const turnId = ensureTalkTurn();
				emitTalkEvent({
					type: role === "assistant" ? isFinal ? "output.text.done" : "output.text.delta" : isFinal ? "transcript.done" : "transcript.delta",
					turnId,
					payload: role === "assistant" ? { text } : {
						role,
						text
					},
					final: isFinal
				});
				if (role === "user" && isFinal) emitTalkEvent({
					type: "input.audio.committed",
					turnId,
					payload: {
						callId,
						providerCallId: callSid
					},
					final: true
				});
				if (!isFinal) {
					if (role === "user" && text.trim()) {
						const transcript = this.recordPartialUserTranscript(callId, text);
						console.log(`[voice-call] realtime input transcript callId=${callId} providerCallId=${callSid} final=false chars=${text.trim().length} aggregateChars=${transcript.length}`);
					}
					return;
				}
				if (role === "user") {
					const transcript = this.recordPartialUserTranscript(callId, text);
					this.clearPartialUserTranscript(callId);
					this.setRecentFinalUserTranscript(callId, transcript);
					console.log(`[voice-call] realtime input transcript callId=${callId} providerCallId=${callSid} final=true chars=${text.trim().length} aggregateChars=${transcript.length}`);
					const event = {
						id: `realtime-speech-${callSid}-${Date.now()}`,
						type: "call.speech",
						callId,
						providerCallId: callSid,
						timestamp: Date.now(),
						transcript,
						isFinal: true
					};
					this.manager.processEvent(event);
					this.scheduleForcedAgentConsult({
						session,
						callId,
						callSid,
						transcript,
						clearAudio: () => {
							const clearedBytes = audioPacer.clearAudio();
							console.log(`[voice-call] realtime forced consult cleared outbound audio callId=${callId} providerCallId=${callSid} queuedBytes=${clearedBytes}`);
						}
					});
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
				const turnId = ensureTalkTurn();
				emitTalkEvent({
					type: "tool.call",
					turnId,
					itemId: toolEvent.itemId,
					callId: toolEvent.callId,
					payload: {
						name: toolEvent.name,
						args: toolEvent.args
					}
				});
				console.log(`[voice-call] realtime tool call received callId=${callId} providerCallId=${callSid} tool=${toolEvent.name}`);
				this.executeToolCall(session, callId, toolEvent.callId || toolEvent.itemId, toolEvent.name, toolEvent.args, turnId, emitTalkEvent);
			},
			onEvent: (event) => {
				if (event.type === "input_audio_buffer.speech_started") {
					ensureTalkTurn();
					return;
				}
				if (event.type === "input_audio_buffer.speech_stopped") {
					const turnId = talk.activeTurnId;
					if (!turnId) return;
					emitTalkEvent({
						type: "input.audio.committed",
						turnId,
						payload: {
							callId,
							providerCallId: callSid,
							source: event.type
						},
						final: true
					});
					return;
				}
				if (event.type === "response.done") {
					finishOutputAudio("response.done");
					endTalkTurn("response.done");
					return;
				}
				if (event.type === "error") emitTalkEvent({
					type: "session.error",
					payload: { message: event.detail ?? "Realtime provider error" },
					final: true
				});
			},
			onReady: () => {
				emitTalkEvent({
					type: "session.ready",
					payload: {
						callId,
						providerCallId: callSid
					}
				});
			},
			onError: (error) => {
				console.error("[voice-call] realtime voice error:", error.message);
				emitTalkEvent({
					type: "session.error",
					payload: { message: error.message },
					final: true
				});
			},
			onClose: (reason) => {
				this.activeBridgesByCallId.delete(callId);
				this.activeBridgesByCallId.delete(callSid);
				this.activeTelephonyClosersByCallId.delete(callId);
				this.activeTelephonyClosersByCallId.delete(callSid);
				this.clearUserTranscriptState(callId);
				finishOutputAudio(reason);
				emitTalkEvent({
					type: "session.closed",
					payload: { reason },
					final: true
				});
				if (reason !== "error") return;
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
		const closeTelephony = (reason) => {
			emitCallEnd(reason);
			session.close();
		};
		this.activeBridgesByCallId.set(callId, session);
		this.activeBridgesByCallId.set(callSid, session);
		this.activeTelephonyClosersByCallId.set(callId, closeTelephony);
		this.activeTelephonyClosersByCallId.set(callSid, closeTelephony);
		const sendAudioToSession = session.sendAudio.bind(session);
		session.sendAudio = (audio) => {
			if (speechDetector.accept(audio)) {
				const interruptedTurnId = ensureTalkTurn();
				const clearedBytes = audioPacer.clearAudio();
				console.log(`[voice-call] realtime outbound audio cleared by barge-in callId=${callId} providerCallId=${callSid} queuedBytes=${clearedBytes}`);
				finishOutputAudio("barge-in");
				const cancelled = talk.cancelTurn({
					turnId: interruptedTurnId,
					payload: {
						callId,
						providerCallId: callSid,
						reason: "barge-in"
					}
				});
				if (cancelled.ok) rememberTalkEvent(cancelled.event);
			}
			emitTalkEvent({
				type: "input.audio.delta",
				turnId: ensureTalkTurn(),
				payload: { byteLength: audio.length }
			});
			sendAudioToSession(audio);
		};
		const closeSession = session.close.bind(session);
		session.close = () => {
			this.activeBridgesByCallId.delete(callId);
			this.activeBridgesByCallId.delete(callSid);
			this.activeTelephonyClosersByCallId.delete(callId);
			this.activeTelephonyClosersByCallId.delete(callSid);
			this.clearUserTranscriptState(callId);
			this.clearForcedConsultState(callId);
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
	recordPartialUserTranscript(callId, text) {
		const next = limitPartialUserTranscript(appendTranscriptText(this.partialUserTranscriptsByCallId.get(callId), text));
		this.partialUserTranscriptsByCallId.set(callId, next);
		this.partialUserTranscriptUpdatedAtByCallId.set(callId, Date.now());
		return next;
	}
	clearPartialUserTranscript(callId) {
		this.partialUserTranscriptsByCallId.delete(callId);
		this.partialUserTranscriptUpdatedAtByCallId.delete(callId);
	}
	setRecentFinalUserTranscript(callId, text) {
		this.clearRecentFinalUserTranscript(callId);
		this.recentFinalUserTranscriptsByCallId.set(callId, text);
		const timer = setTimeout(() => {
			if (this.recentFinalUserTranscriptsByCallId.get(callId) === text) this.recentFinalUserTranscriptsByCallId.delete(callId);
			this.recentFinalUserTranscriptTimersByCallId.delete(callId);
		}, RECENT_FINAL_USER_TRANSCRIPT_TTL_MS);
		timer.unref?.();
		this.recentFinalUserTranscriptTimersByCallId.set(callId, timer);
	}
	clearRecentFinalUserTranscript(callId) {
		const timer = this.recentFinalUserTranscriptTimersByCallId.get(callId);
		if (timer) {
			clearTimeout(timer);
			this.recentFinalUserTranscriptTimersByCallId.delete(callId);
		}
		this.recentFinalUserTranscriptsByCallId.delete(callId);
	}
	clearUserTranscriptState(callId) {
		this.clearPartialUserTranscript(callId);
		this.clearRecentFinalUserTranscript(callId);
	}
	resolveUserTranscriptContext(callId) {
		return this.partialUserTranscriptsByCallId.get(callId) ?? this.recentFinalUserTranscriptsByCallId.get(callId);
	}
	consumePartialUserTranscript(callId, consumed) {
		const text = consumed?.trim();
		if (!text) return;
		const current = this.partialUserTranscriptsByCallId.get(callId);
		if (!current) return;
		if (current === text) {
			this.clearPartialUserTranscript(callId);
			return;
		}
		if (current.toLowerCase().startsWith(text.toLowerCase())) {
			const remaining = current.slice(text.length).trimStart();
			if (remaining) this.partialUserTranscriptsByCallId.set(callId, remaining);
			else this.clearPartialUserTranscript(callId);
		}
		const recent = this.recentFinalUserTranscriptsByCallId.get(callId);
		if (!recent) return;
		if (recent === text || recent.toLowerCase().startsWith(text.toLowerCase())) this.clearRecentFinalUserTranscript(callId);
	}
	async waitForConsultTranscriptSettle(callId, startedAt) {
		const deadline = startedAt + CONSULT_TRANSCRIPT_SETTLE_MAX_MS;
		while (true) {
			const updatedAt = this.partialUserTranscriptUpdatedAtByCallId.get(callId);
			if (!updatedAt) return;
			const now = Date.now();
			const quietFor = now - updatedAt;
			if (quietFor >= CONSULT_TRANSCRIPT_SETTLE_MS || now >= deadline) return;
			await new Promise((resolve) => setTimeout(resolve, Math.min(CONSULT_TRANSCRIPT_SETTLE_MS - quietFor, deadline - now)));
		}
	}
	clearForcedConsultState(callId) {
		const timer = this.forcedConsultTimersByCallId.get(callId);
		if (timer) {
			clearTimeout(timer);
			this.forcedConsultTimersByCallId.delete(callId);
		}
		this.forcedConsultInFlightByCallId.delete(callId);
		this.forcedConsultsByCallId.delete(callId);
		this.lastProviderConsultAtByCallId.delete(callId);
	}
	closeTelephonyBridge(callIdOrSid, bridge, reason) {
		const closer = this.activeTelephonyClosersByCallId.get(callIdOrSid);
		if (closer) {
			closer(reason);
			return;
		}
		bridge?.close();
	}
	scheduleForcedAgentConsult(params) {
		if (this.config.consultPolicy !== "always") return;
		const question = params.transcript.trim();
		if (!question) return;
		const handler = this.toolHandlers.get(REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME);
		if (!handler) return;
		const existingTimer = this.forcedConsultTimersByCallId.get(params.callId);
		if (existingTimer) clearTimeout(existingTimer);
		const timer = setTimeout(() => {
			this.forcedConsultTimersByCallId.delete(params.callId);
			if (this.forcedConsultInFlightByCallId.has(params.callId)) return;
			const lastProviderConsultAt = this.lastProviderConsultAtByCallId.get(params.callId) ?? 0;
			if (Date.now() - lastProviderConsultAt < 2e3) return;
			this.runForcedAgentConsult({
				...params,
				question,
				handler
			});
		}, FORCED_CONSULT_FALLBACK_DELAY_MS);
		this.forcedConsultTimersByCallId.set(params.callId, timer);
	}
	async runForcedAgentConsult(params) {
		this.forcedConsultInFlightByCallId.add(params.callId);
		const startedAt = Date.now();
		console.log(`[voice-call] realtime forced agent consult starting callId=${params.callId} providerCallId=${params.callSid} chars=${params.question.length}`);
		params.clearAudio();
		const state = {
			sendSpeechPrompt: true,
			promise: Promise.resolve().then(() => params.handler({
				question: params.question,
				context: "The realtime provider produced a final user transcript without invoking openclaw_agent_consult, so OpenClaw is forcing the consult because consultPolicy is always."
			}, params.callId, {}))
		};
		this.forcedConsultsByCallId.set(params.callId, state);
		try {
			const result = await state.promise;
			state.completedAt = Date.now();
			const text = readSpeakableToolResultText(result);
			if (!text) {
				console.warn(`[voice-call] realtime forced agent consult returned no speakable text callId=${params.callId} providerCallId=${params.callSid}`);
				return;
			}
			if (state.sendSpeechPrompt) {
				params.clearAudio();
				params.session.sendUserMessage(buildForcedConsultSpeechPrompt(text));
			}
			console.log(`[voice-call] realtime forced agent consult completed callId=${params.callId} providerCallId=${params.callSid} elapsedMs=${Date.now() - startedAt}`);
			this.consumePartialUserTranscript(params.callId, params.question);
		} catch (error) {
			console.warn(`[voice-call] realtime forced agent consult failed callId=${params.callId} providerCallId=${params.callSid} error=${formatErrorMessage(error)}`);
		} finally {
			this.forcedConsultInFlightByCallId.delete(params.callId);
			setTimeout(() => {
				if (this.forcedConsultsByCallId.get(params.callId) === state) this.forcedConsultsByCallId.delete(params.callId);
			}, FORCED_CONSULT_NATIVE_DEDUPE_MS).unref?.();
		}
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
	async executeToolCall(bridge, callId, bridgeCallId, name, args, turnId, emitTalkEvent) {
		const handler = this.toolHandlers.get(name);
		const startedAt = Date.now();
		const hasResultError = (result) => {
			return Boolean(result && typeof result === "object" && !Array.isArray(result) && "error" in result);
		};
		const emitFinalToolEvent = (result) => {
			emitTalkEvent?.({
				type: hasResultError(result) ? "tool.error" : "tool.result",
				turnId,
				callId: bridgeCallId,
				payload: {
					name,
					result
				},
				final: true
			});
		};
		const submitFinalToolResult = (result) => {
			bridge.submitToolResult(bridgeCallId, result);
			emitFinalToolEvent(result);
		};
		const submitWorkingResponse = () => {
			if (handler && name === "openclaw_agent_consult" && bridge.bridge.supportsToolResultContinuation && !this.config.fastContext.enabled) {
				emitTalkEvent?.({
					type: "tool.progress",
					turnId,
					callId: bridgeCallId,
					payload: {
						name,
						status: "working"
					}
				});
				bridge.submitToolResult(bridgeCallId, buildRealtimeVoiceAgentConsultWorkingResponse("caller"), { willContinue: true });
			}
		};
		if (name === "openclaw_agent_consult") {
			this.lastProviderConsultAtByCallId.set(callId, Date.now());
			const timer = this.forcedConsultTimersByCallId.get(callId);
			if (timer) {
				clearTimeout(timer);
				this.forcedConsultTimersByCallId.delete(callId);
			}
			const forcedConsult = this.forcedConsultsByCallId.get(callId);
			if (forcedConsult) {
				if (forcedConsult.completedAt) {
					submitFinalToolResult({
						status: "already_delivered",
						message: "OpenClaw already delivered this consult result internally. Do not repeat it."
					});
					return;
				}
				forcedConsult.sendSpeechPrompt = false;
				submitFinalToolResult(await forcedConsult.promise.catch((error) => ({ error: formatErrorMessage(error) })));
				return;
			}
			const existingNativeConsult = this.nativeConsultsInFlightByCallId.get(callId);
			if (existingNativeConsult) {
				console.log(`[voice-call] realtime tool call sharing in-flight agent consult callId=${callId} ageMs=${Date.now() - existingNativeConsult.startedAt}`);
				submitWorkingResponse();
				submitFinalToolResult(await existingNativeConsult.promise);
				return;
			}
			submitWorkingResponse();
			const state = {
				startedAt,
				promise: Promise.resolve()
			};
			state.promise = (async () => {
				await this.waitForConsultTranscriptSettle(callId, startedAt);
				const context = { partialUserTranscript: this.resolveUserTranscriptContext(callId) };
				state.partialUserTranscript = context.partialUserTranscript;
				const handlerArgs = withFallbackConsultQuestion(args, context.partialUserTranscript);
				console.log(`[voice-call] realtime tool call executing callId=${callId} tool=${name} hasHandler=${Boolean(handler)}`);
				return !handler ? { error: `Tool "${name}" not available` } : await handler(handlerArgs, callId, context);
			})().catch((error) => ({ error: formatErrorMessage(error) }));
			this.nativeConsultsInFlightByCallId.set(callId, state);
			try {
				const result = await state.promise;
				const status = result && typeof result === "object" && !Array.isArray(result) && "error" in result ? "error" : "ok";
				const error = status === "error" && result && typeof result === "object" && !Array.isArray(result) ? formatErrorMessage(result.error ?? "unknown") : void 0;
				console.log(`[voice-call] realtime tool call completed callId=${callId} tool=${name} status=${status} elapsedMs=${Date.now() - startedAt}${error ? ` error=${error}` : ""}`);
				submitFinalToolResult(result);
				if (status === "ok") this.consumePartialUserTranscript(callId, state.partialUserTranscript);
			} finally {
				if (this.nativeConsultsInFlightByCallId.get(callId) === state) this.nativeConsultsInFlightByCallId.delete(callId);
			}
			return;
		}
		console.log(`[voice-call] realtime tool call executing callId=${callId} tool=${name} hasHandler=${Boolean(handler)}`);
		const context = { partialUserTranscript: this.resolveUserTranscriptContext(callId) };
		const handlerArgs = name === "openclaw_agent_consult" ? withFallbackConsultQuestion(args, context.partialUserTranscript) : args;
		const result = !handler ? { error: `Tool "${name}" not available` } : await handler(handlerArgs, callId, context).catch((error) => ({ error: formatErrorMessage(error) }));
		const status = result && typeof result === "object" && !Array.isArray(result) && "error" in result ? "error" : "ok";
		const error = status === "error" && result && typeof result === "object" && !Array.isArray(result) ? formatErrorMessage(result.error ?? "unknown") : void 0;
		console.log(`[voice-call] realtime tool call completed callId=${callId} tool=${name} status=${status} elapsedMs=${Date.now() - startedAt}${error ? ` error=${error}` : ""}`);
		submitFinalToolResult(result);
		if (name === "openclaw_agent_consult" && status === "ok") this.consumePartialUserTranscript(callId, context.partialUserTranscript);
	}
};
//#endregion
export { RealtimeCallHandler };
