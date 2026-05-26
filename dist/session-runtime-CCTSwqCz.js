import { c as normalizeOptionalString$1, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { i as emitTrustedDiagnosticEvent } from "./diagnostic-events-BLgzARSp.js";
import { r as getChildLogger } from "./logger-Dg9dVaLI.js";
import { n as resolvePluginCapabilityProvider, r as resolvePluginCapabilityProviders } from "./capability-provider-runtime-BwiWIvn0.js";
import { n as normalizeCapabilityProviderId, t as buildCapabilityProviderMaps } from "./provider-registry-shared-BvRrJpZ_.js";
import { t as resolveConfiguredCapabilityProvider } from "./provider-selection-runtime-Dmu4VbAd.js";
//#region src/talk/provider-types.ts
const REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ = {
	encoding: "g711_ulaw",
	sampleRateHz: 8e3,
	channels: 1
};
const REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ = {
	encoding: "pcm16",
	sampleRateHz: 24e3,
	channels: 1
};
//#endregion
//#region src/talk/talk-events.ts
const TALK_EVENT_TYPES = [
	"session.started",
	"session.ready",
	"session.closed",
	"session.error",
	"session.replaced",
	"turn.started",
	"turn.ended",
	"turn.cancelled",
	"capture.started",
	"capture.stopped",
	"capture.cancelled",
	"capture.once",
	"input.audio.delta",
	"input.audio.committed",
	"transcript.delta",
	"transcript.done",
	"output.text.delta",
	"output.text.done",
	"output.audio.started",
	"output.audio.delta",
	"output.audio.done",
	"tool.call",
	"tool.progress",
	"tool.result",
	"tool.error",
	"usage.metrics",
	"latency.metrics",
	"health.changed"
];
const TURN_SCOPED_TALK_EVENT_TYPES = new Set([
	"turn.started",
	"turn.ended",
	"turn.cancelled",
	"input.audio.delta",
	"input.audio.committed",
	"transcript.delta",
	"transcript.done",
	"output.text.delta",
	"output.text.done",
	"output.audio.started",
	"output.audio.delta",
	"output.audio.done",
	"tool.call",
	"tool.progress",
	"tool.result",
	"tool.error"
]);
const CAPTURE_SCOPED_TALK_EVENT_TYPES = new Set([
	"capture.started",
	"capture.stopped",
	"capture.cancelled",
	"capture.once"
]);
function assertTalkEventCorrelation(input) {
	if (TURN_SCOPED_TALK_EVENT_TYPES.has(input.type) && !input.turnId?.trim()) throw new Error(`Talk event ${input.type} requires turnId`);
	if (CAPTURE_SCOPED_TALK_EVENT_TYPES.has(input.type) && !input.captureId?.trim()) throw new Error(`Talk event ${input.type} requires captureId`);
}
function createTalkEventSequencer(context, options = {}) {
	let seq = 0;
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	return { next(input) {
		assertTalkEventCorrelation(input);
		seq += 1;
		const timestamp = input.timestamp ?? (() => {
			const value = now();
			return typeof value === "string" ? value : value.toISOString();
		})();
		return {
			...context,
			id: `${context.sessionId}:${seq}`,
			type: input.type,
			turnId: input.turnId,
			captureId: input.captureId,
			seq,
			timestamp,
			final: input.final,
			callId: input.callId,
			itemId: input.itemId,
			parentId: input.parentId,
			payload: input.payload
		};
	} };
}
//#endregion
//#region src/talk/diagnostics.ts
function createTalkDiagnosticEvent(event) {
	const payload = asRecord$1(event.payload);
	return {
		type: "talk.event",
		sessionId: event.sessionId,
		turnId: event.turnId,
		captureId: event.captureId,
		talkEventType: event.type,
		mode: event.mode,
		transport: event.transport,
		brain: event.brain,
		provider: event.provider,
		final: event.final,
		durationMs: firstFiniteNumber$1(payload, [
			"durationMs",
			"latencyMs",
			"elapsedMs"
		]),
		byteLength: firstFiniteNumber$1(payload, ["byteLength", "audioBytes"])
	};
}
function recordTalkDiagnosticEvent(event) {
	emitTrustedDiagnosticEvent(createTalkDiagnosticEvent(event));
}
function asRecord$1(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function firstFiniteNumber$1(record, keys) {
	if (!record) return;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	}
}
//#endregion
//#region src/talk/logging.ts
const OMITTED_TALK_LOG_EVENT_TYPES = new Set([
	"input.audio.delta",
	"output.audio.delta",
	"output.text.delta",
	"transcript.delta",
	"tool.progress"
]);
const TALK_LOGGER_BINDINGS = Object.freeze({ subsystem: "talk" });
function createTalkLogRecord(event) {
	if (OMITTED_TALK_LOG_EVENT_TYPES.has(event.type)) return;
	const payload = asRecord(event.payload);
	const attributes = {
		sessionId: event.sessionId,
		talkEventType: event.type,
		talkMode: event.mode,
		talkTransport: event.transport,
		talkBrain: event.brain
	};
	if (event.provider) attributes.talkProvider = event.provider;
	if (typeof event.final === "boolean") attributes.talkFinal = event.final;
	const durationMs = firstFiniteNumber(payload, [
		"durationMs",
		"latencyMs",
		"elapsedMs"
	]);
	if (durationMs !== void 0) attributes.talkDurationMs = durationMs;
	const byteLength = firstFiniteNumber(payload, ["byteLength", "audioBytes"]);
	if (byteLength !== void 0) attributes.talkByteLength = byteLength;
	return {
		level: event.type === "session.error" || event.type === "tool.error" ? "warn" : "info",
		message: `talk event ${event.type}`,
		attributes
	};
}
function recordTalkLogEvent(event) {
	const record = createTalkLogRecord(event);
	if (!record) return;
	try {
		const logger = getChildLogger(TALK_LOGGER_BINDINGS);
		if (record.level === "warn") {
			logger.warn(record.attributes, record.message);
			return;
		}
		logger.info(record.attributes, record.message);
	} catch {}
}
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function firstFiniteNumber(record, keys) {
	if (!record) return;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	}
}
//#endregion
//#region src/talk/observability.ts
function recordTalkObservabilityEvent(event) {
	recordTalkDiagnosticEvent(event);
	recordTalkLogEvent(event);
}
//#endregion
//#region src/talk/talk-session-controller.ts
function createTalkSessionController(params, options = {}) {
	const { maxRecentEvents = 20, turnIdPrefix = "turn", ...context } = params;
	const sequencer = options.sequencer ?? createTalkEventSequencer(context, { now: options.now });
	const recentEvents = [];
	let activeTurnId;
	let outputAudioActive = false;
	let turnSeq = 0;
	const remember = (event) => {
		recentEvents.push(event);
		if (recentEvents.length > maxRecentEvents) recentEvents.splice(0, recentEvents.length - maxRecentEvents);
		try {
			options.onEvent?.(event);
		} catch {}
		return event;
	};
	const emit = (input) => {
		return remember(sequencer.next(input));
	};
	const resolveActiveTurn = (requestedTurnId) => {
		if (!activeTurnId) return {
			ok: false,
			reason: "no_active_turn"
		};
		const normalizedRequested = normalizeOptionalString(requestedTurnId);
		if (normalizedRequested && normalizedRequested !== activeTurnId) return {
			ok: false,
			reason: "stale_turn"
		};
		return activeTurnId;
	};
	const ensureTurn = (ensureParams = {}) => {
		if (activeTurnId) return { turnId: activeTurnId };
		return startTurn(ensureParams);
	};
	const startTurn = (startParams = {}) => {
		const turnId = normalizeOptionalString(startParams.turnId) ?? `${turnIdPrefix}-${++turnSeq}`;
		outputAudioActive = false;
		activeTurnId = turnId;
		return {
			turnId,
			event: emit({
				type: "turn.started",
				turnId,
				payload: startParams.payload ?? {}
			})
		};
	};
	const finishTurn = (type, paramsForTurn = {}) => {
		const turnId = resolveActiveTurn(paramsForTurn.turnId);
		if (typeof turnId !== "string") return turnId;
		outputAudioActive = false;
		activeTurnId = void 0;
		return {
			ok: true,
			turnId,
			event: emit({
				type,
				turnId,
				payload: paramsForTurn.payload ?? {},
				final: true
			})
		};
	};
	return {
		get activeTurnId() {
			return activeTurnId;
		},
		context,
		get outputAudioActive() {
			return outputAudioActive;
		},
		get recentEvents() {
			return recentEvents;
		},
		clearActiveTurn() {
			activeTurnId = void 0;
			outputAudioActive = false;
		},
		emit,
		ensureTurn,
		startTurn,
		endTurn(paramsForTurn) {
			return finishTurn("turn.ended", paramsForTurn);
		},
		cancelTurn(paramsForTurn) {
			return finishTurn("turn.cancelled", paramsForTurn);
		},
		finishOutputAudio(paramsForOutput = {}) {
			if (!outputAudioActive) return;
			const turnId = resolveActiveTurn(paramsForOutput.turnId);
			if (typeof turnId !== "string") return;
			outputAudioActive = false;
			return emit({
				type: "output.audio.done",
				turnId,
				payload: paramsForOutput.payload ?? {},
				final: true
			});
		},
		startOutputAudio(paramsForOutput = {}) {
			const turn = ensureTurn({
				turnId: paramsForOutput.turnId,
				payload: {}
			});
			if (outputAudioActive) return { turnId: turn.turnId };
			outputAudioActive = true;
			return {
				turnId: turn.turnId,
				event: emit({
					type: "output.audio.started",
					turnId: turn.turnId,
					payload: paramsForOutput.payload ?? {}
				})
			};
		}
	};
}
function normalizeTalkTransport(value) {
	const normalized = normalizeOptionalString(value);
	if (!normalized) return;
	if (normalized === "webrtc-sdp") return "webrtc";
	if (normalized === "json-pcm-websocket") return "provider-websocket";
	return normalized;
}
function normalizeOptionalString(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
//#endregion
//#region src/talk/agent-consult-tool.ts
const REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME = "openclaw_agent_consult";
const REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES = [
	"safe-read-only",
	"owner",
	"none"
];
const REALTIME_VOICE_AGENT_CONSULT_TOOL = {
	type: "function",
	name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
	description: "Delegate the caller's request to the configured OpenClaw agent for normal tool-backed work, actions, context, memory, or reasoning before speaking.",
	parameters: {
		type: "object",
		properties: {
			question: {
				type: "string",
				description: "The concrete question or task the user asked."
			},
			context: {
				type: "string",
				description: "Optional relevant context or transcript summary."
			},
			responseStyle: {
				type: "string",
				description: "Optional style hint for the spoken answer."
			}
		},
		required: ["question"]
	}
};
function buildRealtimeVoiceAgentConsultWorkingResponse(audienceLabel = "person") {
	return {
		status: "working",
		tool: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
		message: `Tell the ${audienceLabel} briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.`
	};
}
const SAFE_READ_ONLY_TOOLS = [
	"read",
	"web_search",
	"web_fetch",
	"x_search",
	"memory_search",
	"memory_get"
];
function isRealtimeVoiceAgentConsultToolPolicy(value) {
	return typeof value === "string" && REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES.includes(value);
}
function resolveRealtimeVoiceAgentConsultToolPolicy(value, fallback) {
	const normalized = normalizeOptionalLowercaseString(value);
	return isRealtimeVoiceAgentConsultToolPolicy(normalized) ? normalized : fallback;
}
function resolveRealtimeVoiceAgentConsultTools(policy, customTools = []) {
	const tools = /* @__PURE__ */ new Map();
	if (policy !== "none") tools.set(REALTIME_VOICE_AGENT_CONSULT_TOOL.name, REALTIME_VOICE_AGENT_CONSULT_TOOL);
	for (const tool of customTools) if (!tools.has(tool.name)) tools.set(tool.name, tool);
	return [...tools.values()];
}
function resolveRealtimeVoiceAgentConsultToolsAllow(policy) {
	if (policy === "owner") return;
	if (policy === "safe-read-only") return [...SAFE_READ_ONLY_TOOLS];
	return [];
}
function buildRealtimeVoiceAgentConsultPolicyInstructions(config) {
	if (config.toolPolicy === "none" || !config.consultPolicy || config.consultPolicy === "auto") return;
	if (config.consultPolicy === "always") return [
		"Consult behavior:",
		"- Call openclaw_agent_consult before every substantive answer.",
		"- You may answer directly only for greetings, acknowledgements, brief latency tests, or filler while waiting for the consult result.",
		"- After the consult result arrives, speak that result concisely."
	].join("\n");
	return [
		"Consult behavior:",
		"- Answer directly for greetings, acknowledgements, simple conversational glue, and brief latency tests.",
		"- Call openclaw_agent_consult before answering requests that need facts, memory, current information, tools, workspace state, or the user's OpenClaw-specific context.",
		"- Keep spoken replies concise and natural."
	].join("\n");
}
function parseRealtimeVoiceAgentConsultArgs(args) {
	const question = readConsultStringArg(args, "question") ?? readConsultStringArg(args, "prompt") ?? readConsultStringArg(args, "query") ?? readConsultStringArg(args, "task");
	if (!question) throw new Error("question required");
	return {
		question,
		context: readConsultStringArg(args, "context"),
		responseStyle: readConsultStringArg(args, "responseStyle")
	};
}
function buildRealtimeVoiceAgentConsultChatMessage(args) {
	const parsed = parseRealtimeVoiceAgentConsultArgs(args);
	return [
		parsed.question,
		parsed.context ? `Context:\n${parsed.context}` : void 0,
		parsed.responseStyle ? `Spoken style:\n${parsed.responseStyle}` : void 0
	].filter(Boolean).join("\n\n");
}
function buildRealtimeVoiceAgentConsultPrompt(params) {
	const parsed = parseRealtimeVoiceAgentConsultArgs(params.args);
	const assistantLabel = params.assistantLabel ?? "Agent";
	const questionSourceLabel = params.questionSourceLabel ?? params.userLabel.toLowerCase();
	const transcript = params.transcript.slice(-12).map((entry) => `${entry.role === "assistant" ? assistantLabel : params.userLabel}: ${entry.text}`).join("\n");
	return [
		`Live voice request from the ${questionSourceLabel} during ${params.surface}.`,
		"Act as the configured OpenClaw agent on behalf of this user. Use available tools when the request asks you to do work.",
		"When finished, return only the concise result the realtime voice agent should speak back.",
		"Do not include markdown, tool logs, or private reasoning. Include citations only when the spoken answer needs them.",
		parsed.responseStyle ? `Spoken style: ${parsed.responseStyle}` : void 0,
		transcript ? `Recent voice transcript for context:\n${transcript}` : void 0,
		parsed.context ? `Additional realtime context:\n${parsed.context}` : void 0,
		`User request:\n${parsed.question}`
	].filter(Boolean).join("\n\n");
}
function collectRealtimeVoiceAgentConsultVisibleText(payloads) {
	const chunks = [];
	for (const payload of payloads) {
		if (payload.isError || payload.isReasoning) continue;
		const text = normalizeOptionalString$1(payload.text);
		if (text) chunks.push(text);
	}
	return chunks.length > 0 ? chunks.join("\n\n").trim() : null;
}
function readConsultStringArg(args, key) {
	if (!args || typeof args !== "object" || Array.isArray(args)) return;
	return normalizeOptionalString$1(args[key]);
}
//#endregion
//#region src/talk/provider-registry.ts
function normalizeRealtimeVoiceProviderId(providerId) {
	return normalizeCapabilityProviderId(providerId);
}
function resolveRealtimeVoiceProviderEntries(cfg) {
	return resolvePluginCapabilityProviders({
		key: "realtimeVoiceProviders",
		cfg
	});
}
function buildProviderMaps(cfg) {
	return buildCapabilityProviderMaps(resolveRealtimeVoiceProviderEntries(cfg));
}
function listRealtimeVoiceProviders(cfg) {
	return [...buildProviderMaps(cfg).canonical.values()];
}
function getRealtimeVoiceProvider(providerId, cfg) {
	const normalized = normalizeRealtimeVoiceProviderId(providerId);
	if (!normalized) return;
	const directProvider = resolvePluginCapabilityProvider({
		key: "realtimeVoiceProviders",
		providerId: normalized,
		cfg
	});
	if (directProvider) return directProvider;
	return buildProviderMaps(cfg).aliases.get(normalized);
}
function canonicalizeRealtimeVoiceProviderId(providerId, cfg) {
	const normalized = normalizeRealtimeVoiceProviderId(providerId);
	if (!normalized) return;
	return getRealtimeVoiceProvider(normalized, cfg)?.id ?? normalized;
}
//#endregion
//#region src/talk/provider-resolver.ts
function resolveConfiguredRealtimeVoiceProvider(params) {
	const cfgForResolve = params.cfgForResolve ?? params.cfg ?? {};
	const providers = params.providers ?? listRealtimeVoiceProviders(params.cfg);
	const resolution = resolveConfiguredCapabilityProvider({
		configuredProviderId: params.configuredProviderId,
		providerConfigs: params.providerConfigs,
		cfg: params.cfg,
		cfgForResolve,
		getConfiguredProvider: (providerId) => params.providers?.find((entry) => entry.id === providerId) ?? getRealtimeVoiceProvider(providerId, params.cfg),
		listProviders: () => providers,
		resolveProviderConfig: ({ provider, cfg, rawConfig }) => {
			const rawConfigWithOverrides = {
				...params.defaultModel && rawConfig.model === void 0 ? {
					...rawConfig,
					model: params.defaultModel
				} : rawConfig,
				...params.providerConfigOverrides
			};
			return provider.resolveConfig?.({
				cfg,
				rawConfig: rawConfigWithOverrides
			}) ?? rawConfigWithOverrides;
		},
		isProviderConfigured: ({ provider, cfg, providerConfig }) => provider.isConfigured({
			cfg,
			providerConfig
		})
	});
	if (!resolution.ok && resolution.code === "missing-configured-provider") throw new Error(`Realtime voice provider "${resolution.configuredProviderId}" is not registered`);
	if (!resolution.ok && resolution.code === "no-registered-provider") throw new Error(params.noRegisteredProviderMessage ?? "No realtime voice provider registered");
	if (!resolution.ok) throw new Error(`Realtime voice provider "${resolution.provider?.id}" is not configured`);
	return {
		provider: resolution.provider,
		providerConfig: resolution.providerConfig
	};
}
//#endregion
//#region src/talk/session-runtime.ts
function createRealtimeVoiceBridgeSession(params) {
	let bridge;
	const requireBridge = () => {
		if (!bridge) throw new Error("Realtime voice bridge is not ready");
		return bridge;
	};
	const session = {
		get bridge() {
			return requireBridge();
		},
		acknowledgeMark: () => requireBridge().acknowledgeMark(),
		close: () => requireBridge().close(),
		connect: () => requireBridge().connect(),
		sendAudio: (audio) => requireBridge().sendAudio(audio),
		sendUserMessage: (text) => requireBridge().sendUserMessage?.(text),
		handleBargeIn: (options) => requireBridge().handleBargeIn?.(options),
		setMediaTimestamp: (ts) => requireBridge().setMediaTimestamp(ts),
		submitToolResult: (callId, result, options) => requireBridge().submitToolResult(callId, result, options),
		triggerGreeting: (instructions) => requireBridge().triggerGreeting?.(instructions)
	};
	const canSendAudio = () => params.audioSink.isOpen?.() ?? true;
	bridge = params.provider.createBridge({
		cfg: params.cfg,
		providerConfig: params.providerConfig,
		audioFormat: params.audioFormat,
		instructions: params.instructions,
		autoRespondToAudio: params.autoRespondToAudio,
		interruptResponseOnInputAudio: params.interruptResponseOnInputAudio,
		tools: params.tools,
		onAudio: (audio) => {
			if (canSendAudio()) params.audioSink.sendAudio(audio);
		},
		onClearAudio: () => {
			if (canSendAudio()) params.audioSink.clearAudio?.();
		},
		onMark: (markName) => {
			if (!canSendAudio() || params.markStrategy === "ignore") return;
			if (params.markStrategy === "ack-immediately") {
				bridge?.acknowledgeMark();
				return;
			}
			if (params.markStrategy === void 0 || params.markStrategy === "transport") params.audioSink.sendMark?.(markName);
		},
		onTranscript: params.onTranscript,
		onEvent: params.onEvent,
		onToolCall: (event) => {
			if (!bridge) return;
			params.onToolCall?.(event, session);
		},
		onReady: () => {
			if (!bridge) return;
			if (params.triggerGreetingOnReady) bridge.triggerGreeting?.(params.initialGreetingInstructions);
			params.onReady?.(session);
		},
		onError: params.onError,
		onClose: params.onClose
	});
	return session;
}
//#endregion
export { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ as A, createTalkLogRecord as C, TALK_EVENT_TYPES as D, recordTalkDiagnosticEvent as E, createTalkEventSequencer as O, recordTalkObservabilityEvent as S, createTalkDiagnosticEvent as T, resolveRealtimeVoiceAgentConsultToolPolicy as _, listRealtimeVoiceProviders as a, createTalkSessionController as b, REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME as c, buildRealtimeVoiceAgentConsultPolicyInstructions as d, buildRealtimeVoiceAgentConsultPrompt as f, parseRealtimeVoiceAgentConsultArgs as g, isRealtimeVoiceAgentConsultToolPolicy as h, getRealtimeVoiceProvider as i, REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ as k, REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES as l, collectRealtimeVoiceAgentConsultVisibleText as m, resolveConfiguredRealtimeVoiceProvider as n, normalizeRealtimeVoiceProviderId as o, buildRealtimeVoiceAgentConsultWorkingResponse as p, canonicalizeRealtimeVoiceProviderId as r, REALTIME_VOICE_AGENT_CONSULT_TOOL as s, createRealtimeVoiceBridgeSession as t, buildRealtimeVoiceAgentConsultChatMessage as u, resolveRealtimeVoiceAgentConsultTools as v, recordTalkLogEvent as w, normalizeTalkTransport as x, resolveRealtimeVoiceAgentConsultToolsAllow as y };
