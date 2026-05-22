import { c as normalizeOptionalString } from "../../string-coerce-Bje8XVt9.js";
import { l as normalizeResolvedSecretInputString } from "../../types.secrets-CyuYZNvB.js";
import "../../text-runtime-CFBwIeh_.js";
import "../../secret-input-CBwDj35T.js";
import { c as REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, y as REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ } from "../../session-runtime-WZKkWO1r.js";
import { i as resamplePcm, n as mulawToPcm, t as convertPcmToMulaw8k } from "../../realtime-voice-B1VSJ5ic.js";
import { t as createGoogleGenAI } from "../../google-genai-runtime-BRECUpVN.js";
import { randomUUID } from "node:crypto";
import { ActivityHandling, Behavior, EndSensitivity, FunctionResponseScheduling, Modality, StartSensitivity, TurnCoverage } from "@google/genai";
//#region extensions/google/realtime-voice-provider.ts
const GOOGLE_REALTIME_DEFAULT_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
const GOOGLE_REALTIME_DEFAULT_VOICE = "Kore";
const GOOGLE_REALTIME_DEFAULT_API_VERSION = "v1beta";
const GOOGLE_REALTIME_INPUT_SAMPLE_RATE = 16e3;
const GOOGLE_REALTIME_BROWSER_API_VERSION = "v1alpha";
const GOOGLE_REALTIME_BROWSER_WEBSOCKET_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
const MAX_PENDING_AUDIO_CHUNKS = 320;
const DEFAULT_AUDIO_STREAM_END_SILENCE_MS = 700;
const GOOGLE_REALTIME_BROWSER_SESSION_TTL_MS = 1800 * 1e3;
const GOOGLE_REALTIME_BROWSER_NEW_SESSION_TTL_MS = 60 * 1e3;
function trimToUndefined(value) {
	return normalizeOptionalString(value);
}
function asFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function asBoolean(value) {
	return typeof value === "boolean" ? value : void 0;
}
function asSensitivity(value) {
	const normalized = normalizeOptionalString(value)?.toLowerCase();
	return normalized === "low" || normalized === "high" ? normalized : void 0;
}
function asThinkingLevel(value) {
	const normalized = normalizeOptionalString(value)?.toLowerCase();
	return normalized === "minimal" || normalized === "low" || normalized === "medium" || normalized === "high" ? normalized : void 0;
}
function asActivityHandling(value) {
	switch (normalizeOptionalString(value)?.toLowerCase().replaceAll("_", "-")) {
		case "start-of-activity-interrupts":
		case "start-of-activity-interrupt":
		case "interrupt":
		case "interrupts": return "start-of-activity-interrupts";
		case "no-interruption":
		case "no-interruptions":
		case "none": return "no-interruption";
		default: return;
	}
}
function asTurnCoverage(value) {
	switch (normalizeOptionalString(value)?.toLowerCase().replaceAll("_", "-")) {
		case "only-activity":
		case "turn-includes-only-activity": return "only-activity";
		case "all-input":
		case "turn-includes-all-input": return "all-input";
		case "audio-activity-and-all-video":
		case "turn-includes-audio-activity-and-all-video": return "audio-activity-and-all-video";
		default: return;
	}
}
function resolveGoogleRealtimeProviderConfigRecord(config) {
	const nested = (typeof config.providers === "object" && config.providers !== null && !Array.isArray(config.providers) ? config.providers : void 0)?.google;
	return typeof nested === "object" && nested !== null && !Array.isArray(nested) ? nested : typeof config.google === "object" && config.google !== null && !Array.isArray(config.google) ? config.google : config;
}
function normalizeProviderConfig(config, cfg) {
	const raw = resolveGoogleRealtimeProviderConfigRecord(config);
	return {
		apiKey: normalizeResolvedSecretInputString({
			value: raw?.apiKey ?? cfg?.models?.providers?.google?.apiKey,
			path: "plugins.entries.voice-call.config.realtime.providers.google.apiKey"
		}),
		model: trimToUndefined(raw?.model),
		voice: trimToUndefined(raw?.voice),
		temperature: asFiniteNumber(raw?.temperature),
		apiVersion: trimToUndefined(raw?.apiVersion),
		prefixPaddingMs: asFiniteNumber(raw?.prefixPaddingMs),
		silenceDurationMs: asFiniteNumber(raw?.silenceDurationMs),
		startSensitivity: asSensitivity(raw?.startSensitivity),
		endSensitivity: asSensitivity(raw?.endSensitivity),
		activityHandling: asActivityHandling(raw?.activityHandling),
		turnCoverage: asTurnCoverage(raw?.turnCoverage),
		automaticActivityDetectionDisabled: asBoolean(raw?.automaticActivityDetectionDisabled),
		enableAffectiveDialog: asBoolean(raw?.enableAffectiveDialog),
		thinkingLevel: asThinkingLevel(raw?.thinkingLevel),
		thinkingBudget: asFiniteNumber(raw?.thinkingBudget)
	};
}
function resolveEnvApiKey() {
	return trimToUndefined(process.env.GEMINI_API_KEY) ?? trimToUndefined(process.env.GOOGLE_API_KEY);
}
function mapStartSensitivity(value) {
	switch (value) {
		case "high": return StartSensitivity.START_SENSITIVITY_HIGH;
		case "low": return StartSensitivity.START_SENSITIVITY_LOW;
		default: return;
	}
}
function mapEndSensitivity(value) {
	switch (value) {
		case "high": return EndSensitivity.END_SENSITIVITY_HIGH;
		case "low": return EndSensitivity.END_SENSITIVITY_LOW;
		default: return;
	}
}
function mapActivityHandling(value) {
	switch (value) {
		case "no-interruption": return ActivityHandling.NO_INTERRUPTION;
		case "start-of-activity-interrupts": return ActivityHandling.START_OF_ACTIVITY_INTERRUPTS;
		default: return;
	}
}
function mapTurnCoverage(value) {
	switch (value) {
		case "only-activity": return TurnCoverage.TURN_INCLUDES_ONLY_ACTIVITY;
		case "all-input": return TurnCoverage.TURN_INCLUDES_ALL_INPUT;
		case "audio-activity-and-all-video": return TurnCoverage.TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO;
		default: return;
	}
}
function buildThinkingConfig(config) {
	if (config.thinkingLevel) return { thinkingLevel: config.thinkingLevel.toUpperCase() };
	if (typeof config.thinkingBudget === "number") return { thinkingBudget: config.thinkingBudget };
}
function buildRealtimeInputConfig(config) {
	const startSensitivity = mapStartSensitivity(config.startSensitivity);
	const endSensitivity = mapEndSensitivity(config.endSensitivity);
	const activityHandling = mapActivityHandling(config.activityHandling);
	const turnCoverage = mapTurnCoverage(config.turnCoverage);
	const automaticActivityDetection = {
		...typeof config.automaticActivityDetectionDisabled === "boolean" ? { disabled: config.automaticActivityDetectionDisabled } : {},
		...startSensitivity ? { startOfSpeechSensitivity: startSensitivity } : {},
		...endSensitivity ? { endOfSpeechSensitivity: endSensitivity } : {},
		...typeof config.prefixPaddingMs === "number" ? { prefixPaddingMs: Math.max(0, Math.floor(config.prefixPaddingMs)) } : {},
		...typeof config.silenceDurationMs === "number" ? { silenceDurationMs: Math.max(0, Math.floor(config.silenceDurationMs)) } : {}
	};
	const realtimeInputConfig = {
		...Object.keys(automaticActivityDetection).length > 0 ? { automaticActivityDetection } : {},
		...activityHandling ? { activityHandling } : {},
		...turnCoverage ? { turnCoverage } : {}
	};
	return Object.keys(realtimeInputConfig).length > 0 ? realtimeInputConfig : void 0;
}
function buildFunctionDeclarations(tools) {
	return (tools ?? []).map((tool) => {
		const declaration = {
			name: tool.name,
			description: tool.description,
			parametersJsonSchema: tool.parameters
		};
		if (tool.name === "openclaw_agent_consult") declaration.behavior = Behavior.NON_BLOCKING;
		return declaration;
	});
}
function buildGoogleLiveConnectConfig(config) {
	const functionDeclarations = buildFunctionDeclarations(config.tools);
	return {
		responseModalities: [Modality.AUDIO],
		...typeof config.temperature === "number" && config.temperature > 0 ? { temperature: config.temperature } : {},
		speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice ?? GOOGLE_REALTIME_DEFAULT_VOICE } } },
		systemInstruction: config.instructions,
		...functionDeclarations.length > 0 ? { tools: [{ functionDeclarations }] } : {},
		...buildRealtimeInputConfig(config) ? { realtimeInputConfig: buildRealtimeInputConfig(config) } : {},
		inputAudioTranscription: {},
		outputAudioTranscription: {},
		...typeof config.enableAffectiveDialog === "boolean" ? { enableAffectiveDialog: config.enableAffectiveDialog } : {},
		...buildThinkingConfig(config) ? { thinkingConfig: buildThinkingConfig(config) } : {}
	};
}
function toGoogleModelResource(model) {
	return model.startsWith("models/") ? model : `models/${model}`;
}
function buildBrowserInitialSetup(model) {
	return { setup: {
		model: toGoogleModelResource(model),
		generationConfig: { responseModalities: [Modality.AUDIO] },
		inputAudioTranscription: {},
		outputAudioTranscription: {}
	} };
}
function parsePcmSampleRate(mimeType) {
	const match = mimeType?.match(/(?:^|[;,\s])rate=(\d+)/i);
	const parsed = match ? Number.parseInt(match[1] ?? "", 10) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 24e3;
}
function isMulawSilence(audio) {
	return audio.length > 0 && audio.every((sample) => sample === 255);
}
function isPcm16Silence(audio) {
	const samples = Math.floor(audio.length / 2);
	if (samples === 0) return false;
	for (let i = 0; i < samples; i += 1) if (audio.readInt16LE(i * 2) !== 0) return false;
	return true;
}
var GoogleRealtimeVoiceBridge = class {
	constructor(config) {
		this.config = config;
		this.supportsToolResultContinuation = true;
		this.session = null;
		this.connected = false;
		this.sessionConfigured = false;
		this.intentionallyClosed = false;
		this.pendingAudio = [];
		this.sessionReadyFired = false;
		this.consecutiveSilenceMs = 0;
		this.audioStreamEnded = false;
		this.pendingFunctionNames = /* @__PURE__ */ new Map();
		this.audioFormat = config.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ;
	}
	async connect() {
		this.intentionallyClosed = false;
		this.sessionConfigured = false;
		this.sessionReadyFired = false;
		this.consecutiveSilenceMs = 0;
		this.audioStreamEnded = false;
		this.pendingFunctionNames.clear();
		const ai = createGoogleGenAI({
			apiKey: this.config.apiKey,
			httpOptions: { apiVersion: this.config.apiVersion ?? GOOGLE_REALTIME_DEFAULT_API_VERSION }
		});
		this.session = await ai.live.connect({
			model: this.config.model ?? GOOGLE_REALTIME_DEFAULT_MODEL,
			config: buildGoogleLiveConnectConfig(this.config),
			callbacks: {
				onopen: () => {
					this.connected = true;
				},
				onmessage: (message) => {
					this.handleMessage(message);
				},
				onerror: (event) => {
					const error = event.error instanceof Error ? event.error : new Error(typeof event.message === "string" ? event.message : "Google Live API error");
					this.config.onError?.(error);
				},
				onclose: () => {
					this.connected = false;
					this.sessionConfigured = false;
					this.pendingFunctionNames.clear();
					const reason = this.intentionallyClosed ? "completed" : "error";
					this.session = null;
					this.config.onClose?.(reason);
				}
			}
		});
	}
	sendAudio(audio) {
		if (!this.session || !this.connected || !this.sessionConfigured) {
			if (this.pendingAudio.length < MAX_PENDING_AUDIO_CHUNKS) this.pendingAudio.push(audio);
			return;
		}
		const silent = this.isSilence(audio);
		if (silent && this.audioStreamEnded) return;
		if (!silent) {
			this.consecutiveSilenceMs = 0;
			this.audioStreamEnded = false;
		}
		const pcm16k = resamplePcm(this.toInputPcm(audio), this.audioFormat.sampleRateHz, GOOGLE_REALTIME_INPUT_SAMPLE_RATE);
		this.session.sendRealtimeInput({ audio: {
			data: pcm16k.toString("base64"),
			mimeType: `audio/pcm;rate=${GOOGLE_REALTIME_INPUT_SAMPLE_RATE}`
		} });
		if (!silent) return;
		const silenceThresholdMs = typeof this.config.silenceDurationMs === "number" ? Math.max(0, Math.floor(this.config.silenceDurationMs)) : DEFAULT_AUDIO_STREAM_END_SILENCE_MS;
		const bytesPerSample = this.audioFormat.encoding === "pcm16" ? 2 : 1;
		this.consecutiveSilenceMs += Math.round(audio.length / bytesPerSample / this.audioFormat.sampleRateHz * 1e3);
		if (!this.audioStreamEnded && this.consecutiveSilenceMs >= silenceThresholdMs) {
			this.session.sendRealtimeInput({ audioStreamEnd: true });
			this.audioStreamEnded = true;
		}
	}
	setMediaTimestamp(_ts) {}
	sendUserMessage(text) {
		const normalized = text.trim();
		if (!normalized || !this.session || !this.connected || !this.sessionConfigured) return;
		this.session.sendClientContent({
			turns: [{
				role: "user",
				parts: [{ text: normalized }]
			}],
			turnComplete: true
		});
	}
	triggerGreeting(instructions) {
		const greetingPrompt = instructions?.trim() || "Start the call now. Greet the caller naturally and keep it brief.";
		this.sendUserMessage(greetingPrompt);
	}
	submitToolResult(callId, result, options) {
		if (!this.session) return;
		const name = this.pendingFunctionNames.get(callId);
		if (!name) {
			this.config.onError?.(/* @__PURE__ */ new Error(`Google Live function response is missing a matching function call for ${callId}`));
			return;
		}
		try {
			const isConsultTool = name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME;
			const functionResponse = {
				id: callId,
				name,
				response: result && typeof result === "object" && !Array.isArray(result) ? result : { output: result }
			};
			if (isConsultTool) {
				functionResponse.scheduling = FunctionResponseScheduling.WHEN_IDLE;
				if (options?.willContinue === true) functionResponse.willContinue = true;
			} else if (options?.willContinue === true) {
				this.config.onError?.(/* @__PURE__ */ new Error(`Google Live continuation is only supported for ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME}`));
				return;
			}
			this.session.sendToolResponse({ functionResponses: [functionResponse] });
			if (options?.willContinue !== true) this.pendingFunctionNames.delete(callId);
		} catch (error) {
			this.config.onError?.(error instanceof Error ? error : /* @__PURE__ */ new Error("Failed to send Google Live function response"));
		}
	}
	acknowledgeMark() {}
	close() {
		this.intentionallyClosed = true;
		this.connected = false;
		this.sessionConfigured = false;
		this.pendingAudio = [];
		this.consecutiveSilenceMs = 0;
		this.audioStreamEnded = false;
		this.pendingFunctionNames.clear();
		const session = this.session;
		this.session = null;
		session?.close();
	}
	isConnected() {
		return this.connected && this.sessionConfigured;
	}
	isSilence(audio) {
		return this.audioFormat.encoding === "pcm16" ? isPcm16Silence(audio) : isMulawSilence(audio);
	}
	toInputPcm(audio) {
		return this.audioFormat.encoding === "pcm16" ? audio : mulawToPcm(audio);
	}
	toOutputAudio(pcm, sampleRate) {
		return this.audioFormat.encoding === "pcm16" ? resamplePcm(pcm, sampleRate, this.audioFormat.sampleRateHz) : convertPcmToMulaw8k(pcm, sampleRate);
	}
	handleMessage(message) {
		if (message.setupComplete) this.handleSetupComplete();
		if (message.serverContent) this.handleServerContent(message.serverContent);
		if (message.toolCall) this.handleToolCall(message.toolCall);
	}
	handleSetupComplete() {
		this.sessionConfigured = true;
		for (const chunk of this.pendingAudio.splice(0)) this.sendAudio(chunk);
		if (!this.sessionReadyFired) {
			this.sessionReadyFired = true;
			this.config.onReady?.();
		}
	}
	handleServerContent(content) {
		if (content.interrupted) this.config.onClearAudio();
		if (content.inputTranscription?.text) this.config.onTranscript?.("user", content.inputTranscription.text, content.inputTranscription.finished ?? false);
		if (content.outputTranscription?.text) this.config.onTranscript?.("assistant", content.outputTranscription.text, content.outputTranscription.finished ?? false);
		let emittedAssistantText = false;
		for (const part of content.modelTurn?.parts ?? []) {
			if (part.inlineData?.data) {
				const pcm = Buffer.from(part.inlineData.data, "base64");
				const sampleRate = parsePcmSampleRate(part.inlineData.mimeType);
				const audio = this.toOutputAudio(pcm, sampleRate);
				if (audio.length > 0) {
					this.config.onAudio(audio);
					this.config.onMark?.(`audio-${randomUUID()}`);
				}
				continue;
			}
			if (part.thought) continue;
			if (!content.outputTranscription?.text && typeof part.text === "string" && part.text.trim()) {
				emittedAssistantText = true;
				this.config.onTranscript?.("assistant", part.text, content.turnComplete ?? false);
			}
		}
		if (!emittedAssistantText && content.turnComplete && content.waitingForInput === false) return;
	}
	handleToolCall(toolCall) {
		for (const call of toolCall.functionCalls ?? []) {
			const name = call.name?.trim();
			if (!name) continue;
			const callId = call.id?.trim() || `google-live-${randomUUID()}`;
			this.pendingFunctionNames.set(callId, name);
			this.config.onToolCall?.({
				itemId: callId,
				callId,
				name,
				args: call.args ?? {}
			});
		}
	}
};
async function createGoogleRealtimeBrowserSession(req) {
	const config = normalizeProviderConfig(req.providerConfig);
	const apiKey = config.apiKey || resolveEnvApiKey();
	if (!apiKey) throw new Error("Google Gemini API key missing");
	const model = req.model ?? config.model ?? GOOGLE_REALTIME_DEFAULT_MODEL;
	const voice = req.voice ?? config.voice ?? GOOGLE_REALTIME_DEFAULT_VOICE;
	const expiresAtMs = Date.now() + GOOGLE_REALTIME_BROWSER_SESSION_TTL_MS;
	const newSessionExpiresAtMs = Date.now() + GOOGLE_REALTIME_BROWSER_NEW_SESSION_TTL_MS;
	const clientSecret = (await createGoogleGenAI({
		apiKey,
		httpOptions: { apiVersion: GOOGLE_REALTIME_BROWSER_API_VERSION }
	}).authTokens.create({ config: {
		uses: 1,
		expireTime: new Date(expiresAtMs).toISOString(),
		newSessionExpireTime: new Date(newSessionExpiresAtMs).toISOString(),
		liveConnectConstraints: {
			model,
			config: buildGoogleLiveConnectConfig({
				...config,
				apiKey,
				model,
				voice,
				instructions: req.instructions,
				tools: req.tools
			})
		}
	} })).name?.trim();
	if (!clientSecret) throw new Error("Google Live browser session did not return an ephemeral token");
	return {
		provider: "google",
		transport: "json-pcm-websocket",
		protocol: "google-live-bidi",
		clientSecret,
		websocketUrl: GOOGLE_REALTIME_BROWSER_WEBSOCKET_URL,
		audio: {
			inputEncoding: "pcm16",
			inputSampleRateHz: GOOGLE_REALTIME_INPUT_SAMPLE_RATE,
			outputEncoding: "pcm16",
			outputSampleRateHz: 24e3
		},
		initialMessage: buildBrowserInitialSetup(model),
		model,
		voice,
		expiresAt: Math.floor(expiresAtMs / 1e3)
	};
}
function buildGoogleRealtimeVoiceProvider() {
	return {
		id: "google",
		label: "Google Live Voice",
		autoSelectOrder: 20,
		resolveConfig: ({ cfg, rawConfig }) => normalizeProviderConfig(rawConfig, cfg),
		isConfigured: ({ providerConfig }) => Boolean(normalizeProviderConfig(providerConfig).apiKey || resolveEnvApiKey()),
		createBridge: (req) => {
			const config = normalizeProviderConfig(req.providerConfig);
			const apiKey = config.apiKey || resolveEnvApiKey();
			if (!apiKey) throw new Error("Google Gemini API key missing");
			return new GoogleRealtimeVoiceBridge({
				...req,
				apiKey,
				model: config.model,
				voice: config.voice,
				temperature: config.temperature,
				apiVersion: config.apiVersion,
				prefixPaddingMs: config.prefixPaddingMs,
				silenceDurationMs: config.silenceDurationMs,
				startSensitivity: config.startSensitivity,
				endSensitivity: config.endSensitivity,
				activityHandling: config.activityHandling,
				turnCoverage: config.turnCoverage,
				automaticActivityDetectionDisabled: config.automaticActivityDetectionDisabled,
				enableAffectiveDialog: config.enableAffectiveDialog,
				thinkingLevel: config.thinkingLevel,
				thinkingBudget: config.thinkingBudget
			});
		},
		createBrowserSession: createGoogleRealtimeBrowserSession
	};
}
//#endregion
export { buildGoogleRealtimeVoiceProvider };
