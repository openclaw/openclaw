import { c as normalizeOptionalString$1, s as normalizeOptionalLowercaseString } from "../../string-coerce-Bje8XVt9.js";
import { i as formatErrorMessage } from "../../errors-QN8rySzW.js";
import { c as normalizeAgentId } from "../../session-key-CTLAw4n4.js";
import { n as GatewayClient } from "../../client-XP7CTBMn.js";
import { t as startGatewayClientWhenEventLoopReady } from "../../client-start-readiness-DDS5qywz.js";
import { Xr as errorShape, Yr as ErrorCodes } from "../../protocol-Bj4aFpjA.js";
import { c as isBlockedHostnameOrIp } from "../../ssrf-hMo3P7lU.js";
import "../../text-runtime-CFBwIeh_.js";
import { t as definePluginEntry } from "../../plugin-entry-Qint-vYf.js";
import "../../routing-mgXN0NdW.js";
import "../../error-runtime-D_Qslcoe.js";
import "../../ssrf-runtime-Bozc6A2_.js";
import "../../gateway-runtime-DGG1WHkD.js";
import { n as callGatewayFromCli } from "../../gateway-rpc-Cro_f7bL.js";
import { _ as resolveRealtimeVoiceAgentConsultTools, b as REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ, c as REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, f as buildRealtimeVoiceAgentConsultWorkingResponse, g as resolveRealtimeVoiceAgentConsultToolPolicy, n as resolveConfiguredRealtimeVoiceProvider, t as createRealtimeVoiceBridgeSession, v as resolveRealtimeVoiceAgentConsultToolsAllow, y as REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ } from "../../session-runtime-WZKkWO1r.js";
import { o as consultRealtimeVoiceAgent } from "../../realtime-voice-B1VSJ5ic.js";
import { a as isSameMeetUrlForReuse, c as resolveChromeNode, f as endGoogleMeetActiveConference, g as fetchLatestGoogleMeetConferenceRecord, h as fetchGoogleMeetSpace, i as callBrowserProxyOnNode, l as resolveChromeNodeInfo, m as fetchGoogleMeetAttendance, n as isGoogleMeetBrowserManualActionError, o as normalizeMeetUrlForReuse, p as fetchGoogleMeetArtifacts, r as asBrowserTabs, s as readBrowserTab, t as createMeetWithBrowserProxyOnNode, u as buildGoogleMeetPreflightReport } from "../../chrome-create-DEaPyBNR.js";
import { n as findGoogleMeetCalendarEvent, r as listGoogleMeetCalendarEvents, t as buildGoogleMeetCalendarDayWindow } from "../../calendar-DewN3Mcw.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
//#region extensions/google-meet/src/config.ts
const DEFAULT_GOOGLE_MEET_AUDIO_INPUT_COMMAND = [
	"sox",
	"-q",
	"-t",
	"coreaudio",
	"BlackHole 2ch",
	"-t",
	"raw",
	"-r",
	"24000",
	"-c",
	"1",
	"-e",
	"signed-integer",
	"-b",
	"16",
	"-L",
	"-"
];
const DEFAULT_GOOGLE_MEET_AUDIO_OUTPUT_COMMAND = [
	"sox",
	"-q",
	"-t",
	"raw",
	"-r",
	"24000",
	"-c",
	"1",
	"-e",
	"signed-integer",
	"-b",
	"16",
	"-L",
	"-",
	"-t",
	"coreaudio",
	"BlackHole 2ch"
];
const LEGACY_GOOGLE_MEET_AUDIO_INPUT_COMMAND = [
	"rec",
	"-q",
	"-t",
	"raw",
	"-r",
	"8000",
	"-c",
	"1",
	"-e",
	"mu-law",
	"-b",
	"8",
	"-"
];
const LEGACY_GOOGLE_MEET_AUDIO_OUTPUT_COMMAND = [
	"play",
	"-q",
	"-t",
	"raw",
	"-r",
	"8000",
	"-c",
	"1",
	"-e",
	"mu-law",
	"-b",
	"8",
	"-"
];
const DEFAULT_GOOGLE_MEET_CHROME_AUDIO_FORMAT = "pcm16-24khz";
const DEFAULT_GOOGLE_MEET_BARGE_IN_RMS_THRESHOLD = 650;
const DEFAULT_GOOGLE_MEET_BARGE_IN_PEAK_THRESHOLD = 2500;
const DEFAULT_GOOGLE_MEET_BARGE_IN_COOLDOWN_MS = 900;
const DEFAULT_GOOGLE_MEET_REALTIME_INSTRUCTIONS = `You are joining a private Google Meet as an OpenClaw agent. Keep spoken replies brief and natural. When a question needs deeper reasoning, current information, or tools, call ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} before answering.`;
const DEFAULT_GOOGLE_MEET_REALTIME_INTRO_MESSAGE = "Say exactly: I'm here and listening.";
const DEFAULT_GOOGLE_MEET_CONFIG = {
	enabled: true,
	defaults: {},
	preview: { enrollmentAcknowledged: false },
	defaultTransport: "chrome",
	defaultMode: "realtime",
	chrome: {
		audioBackend: "blackhole-2ch",
		audioFormat: DEFAULT_GOOGLE_MEET_CHROME_AUDIO_FORMAT,
		launch: true,
		guestName: "OpenClaw Agent",
		reuseExistingTab: true,
		autoJoin: true,
		joinTimeoutMs: 3e4,
		waitForInCallMs: 2e4,
		audioInputCommand: [...DEFAULT_GOOGLE_MEET_AUDIO_INPUT_COMMAND],
		audioOutputCommand: [...DEFAULT_GOOGLE_MEET_AUDIO_OUTPUT_COMMAND],
		bargeInRmsThreshold: DEFAULT_GOOGLE_MEET_BARGE_IN_RMS_THRESHOLD,
		bargeInPeakThreshold: DEFAULT_GOOGLE_MEET_BARGE_IN_PEAK_THRESHOLD,
		bargeInCooldownMs: DEFAULT_GOOGLE_MEET_BARGE_IN_COOLDOWN_MS
	},
	chromeNode: {},
	twilio: {},
	voiceCall: {
		enabled: true,
		requestTimeoutMs: 3e4,
		dtmfDelayMs: 2500,
		postDtmfSpeechDelayMs: 5e3
	},
	realtime: {
		provider: "openai",
		instructions: DEFAULT_GOOGLE_MEET_REALTIME_INSTRUCTIONS,
		introMessage: DEFAULT_GOOGLE_MEET_REALTIME_INTRO_MESSAGE,
		toolPolicy: "safe-read-only",
		providers: {}
	},
	oauth: {},
	auth: { provider: "google-oauth" }
};
const GOOGLE_MEET_CLIENT_ID_KEYS = ["OPENCLAW_GOOGLE_MEET_CLIENT_ID", "GOOGLE_MEET_CLIENT_ID"];
const GOOGLE_MEET_CLIENT_SECRET_KEYS = ["OPENCLAW_GOOGLE_MEET_CLIENT_SECRET", "GOOGLE_MEET_CLIENT_SECRET"];
const GOOGLE_MEET_REFRESH_TOKEN_KEYS = ["OPENCLAW_GOOGLE_MEET_REFRESH_TOKEN", "GOOGLE_MEET_REFRESH_TOKEN"];
const GOOGLE_MEET_ACCESS_TOKEN_KEYS = ["OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN", "GOOGLE_MEET_ACCESS_TOKEN"];
const GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT_KEYS = ["OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT", "GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT"];
const GOOGLE_MEET_DEFAULT_MEETING_KEYS = ["OPENCLAW_GOOGLE_MEET_DEFAULT_MEETING", "GOOGLE_MEET_DEFAULT_MEETING"];
const GOOGLE_MEET_PREVIEW_ACK_KEYS = ["OPENCLAW_GOOGLE_MEET_PREVIEW_ACK", "GOOGLE_MEET_PREVIEW_ACK"];
function asRecord$3(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function resolveBoolean(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}
function resolveNumber(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
function resolveOptionalNumber(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : void 0;
	}
}
function readEnvString(env, keys) {
	for (const key of keys) {
		const value = normalizeOptionalString$1(env[key]);
		if (value) return value;
	}
}
function readEnvBoolean(env, keys) {
	const normalized = normalizeOptionalLowercaseString(readEnvString(env, keys));
	if (!normalized) return;
	if ([
		"1",
		"true",
		"yes",
		"on"
	].includes(normalized)) return true;
	if ([
		"0",
		"false",
		"no",
		"off"
	].includes(normalized)) return false;
}
function readEnvNumber(env, keys) {
	return resolveOptionalNumber(readEnvString(env, keys));
}
function resolveStringArray(value) {
	if (!Array.isArray(value)) return;
	const normalized = value.map((entry) => normalizeOptionalString$1(entry)).filter((entry) => Boolean(entry));
	return normalized.length > 0 ? normalized : void 0;
}
function resolveProvidersConfig(value) {
	const raw = asRecord$3(value);
	const providers = {};
	for (const [key, entry] of Object.entries(raw)) {
		const providerId = normalizeOptionalLowercaseString(key);
		if (!providerId) continue;
		providers[providerId] = asRecord$3(entry);
	}
	return providers;
}
function resolveTransport$1(value, fallback) {
	const normalized = normalizeOptionalLowercaseString(value);
	return normalized === "chrome" || normalized === "chrome-node" || normalized === "twilio" ? normalized : fallback;
}
function resolveMode$1(value, fallback) {
	const normalized = normalizeOptionalLowercaseString(value);
	return normalized === "realtime" || normalized === "transcribe" ? normalized : fallback;
}
function resolveChromeAudioFormat(value) {
	switch (normalizeOptionalString$1(value)?.toLowerCase().replaceAll("_", "-")) {
		case "pcm16-24khz":
		case "pcm16-24k":
		case "pcm24":
		case "pcm": return "pcm16-24khz";
		case "g711-ulaw-8khz":
		case "g711-ulaw-8k":
		case "g711-ulaw":
		case "mulaw":
		case "mu-law": return "g711-ulaw-8khz";
		default: return;
	}
}
function defaultAudioInputCommand(format) {
	return format === "g711-ulaw-8khz" ? LEGACY_GOOGLE_MEET_AUDIO_INPUT_COMMAND : DEFAULT_GOOGLE_MEET_AUDIO_INPUT_COMMAND;
}
function defaultAudioOutputCommand(format) {
	return format === "g711-ulaw-8khz" ? LEGACY_GOOGLE_MEET_AUDIO_OUTPUT_COMMAND : DEFAULT_GOOGLE_MEET_AUDIO_OUTPUT_COMMAND;
}
function resolveGoogleMeetConfig(input) {
	return resolveGoogleMeetConfigWithEnv(input);
}
function resolveGoogleMeetConfigWithEnv(input, env = process.env) {
	const raw = asRecord$3(input);
	const defaults = asRecord$3(raw.defaults);
	const preview = asRecord$3(raw.preview);
	const chrome = asRecord$3(raw.chrome);
	const configuredAudioInputCommand = resolveStringArray(chrome.audioInputCommand);
	const configuredAudioOutputCommand = resolveStringArray(chrome.audioOutputCommand);
	const hasCustomAudioCommand = configuredAudioInputCommand !== void 0 || configuredAudioOutputCommand !== void 0;
	const audioFormat = resolveChromeAudioFormat(chrome.audioFormat) ?? (hasCustomAudioCommand ? "g711-ulaw-8khz" : DEFAULT_GOOGLE_MEET_CONFIG.chrome.audioFormat);
	const chromeNode = asRecord$3(raw.chromeNode);
	const twilio = asRecord$3(raw.twilio);
	const voiceCall = asRecord$3(raw.voiceCall);
	const realtime = asRecord$3(raw.realtime);
	const oauth = asRecord$3(raw.oauth);
	const auth = asRecord$3(raw.auth);
	return {
		enabled: resolveBoolean(raw.enabled, DEFAULT_GOOGLE_MEET_CONFIG.enabled),
		defaults: { meeting: normalizeOptionalString$1(defaults.meeting) ?? readEnvString(env, GOOGLE_MEET_DEFAULT_MEETING_KEYS) },
		preview: { enrollmentAcknowledged: resolveBoolean(preview.enrollmentAcknowledged, readEnvBoolean(env, GOOGLE_MEET_PREVIEW_ACK_KEYS) ?? DEFAULT_GOOGLE_MEET_CONFIG.preview.enrollmentAcknowledged) },
		defaultTransport: resolveTransport$1(raw.defaultTransport, DEFAULT_GOOGLE_MEET_CONFIG.defaultTransport),
		defaultMode: resolveMode$1(raw.defaultMode, DEFAULT_GOOGLE_MEET_CONFIG.defaultMode),
		chrome: {
			audioBackend: "blackhole-2ch",
			audioFormat,
			launch: resolveBoolean(chrome.launch, DEFAULT_GOOGLE_MEET_CONFIG.chrome.launch),
			browserProfile: normalizeOptionalString$1(chrome.browserProfile),
			guestName: normalizeOptionalString$1(chrome.guestName) ?? DEFAULT_GOOGLE_MEET_CONFIG.chrome.guestName,
			reuseExistingTab: resolveBoolean(chrome.reuseExistingTab, DEFAULT_GOOGLE_MEET_CONFIG.chrome.reuseExistingTab),
			autoJoin: resolveBoolean(chrome.autoJoin, DEFAULT_GOOGLE_MEET_CONFIG.chrome.autoJoin),
			joinTimeoutMs: resolveNumber(chrome.joinTimeoutMs, DEFAULT_GOOGLE_MEET_CONFIG.chrome.joinTimeoutMs),
			waitForInCallMs: resolveNumber(chrome.waitForInCallMs, DEFAULT_GOOGLE_MEET_CONFIG.chrome.waitForInCallMs),
			audioInputCommand: configuredAudioInputCommand ?? [...defaultAudioInputCommand(audioFormat)],
			audioOutputCommand: configuredAudioOutputCommand ?? [...defaultAudioOutputCommand(audioFormat)],
			bargeInInputCommand: resolveStringArray(chrome.bargeInInputCommand),
			bargeInRmsThreshold: resolveNumber(chrome.bargeInRmsThreshold, DEFAULT_GOOGLE_MEET_CONFIG.chrome.bargeInRmsThreshold),
			bargeInPeakThreshold: resolveNumber(chrome.bargeInPeakThreshold, DEFAULT_GOOGLE_MEET_CONFIG.chrome.bargeInPeakThreshold),
			bargeInCooldownMs: resolveNumber(chrome.bargeInCooldownMs, DEFAULT_GOOGLE_MEET_CONFIG.chrome.bargeInCooldownMs),
			audioBridgeCommand: resolveStringArray(chrome.audioBridgeCommand),
			audioBridgeHealthCommand: resolveStringArray(chrome.audioBridgeHealthCommand)
		},
		chromeNode: { node: normalizeOptionalString$1(chromeNode.node) },
		twilio: {
			defaultDialInNumber: normalizeOptionalString$1(twilio.defaultDialInNumber),
			defaultPin: normalizeOptionalString$1(twilio.defaultPin),
			defaultDtmfSequence: normalizeOptionalString$1(twilio.defaultDtmfSequence)
		},
		voiceCall: {
			enabled: resolveBoolean(voiceCall.enabled, DEFAULT_GOOGLE_MEET_CONFIG.voiceCall.enabled),
			gatewayUrl: normalizeOptionalString$1(voiceCall.gatewayUrl),
			token: normalizeOptionalString$1(voiceCall.token),
			requestTimeoutMs: resolveNumber(voiceCall.requestTimeoutMs, DEFAULT_GOOGLE_MEET_CONFIG.voiceCall.requestTimeoutMs),
			dtmfDelayMs: resolveNumber(voiceCall.dtmfDelayMs, DEFAULT_GOOGLE_MEET_CONFIG.voiceCall.dtmfDelayMs),
			postDtmfSpeechDelayMs: resolveNumber(voiceCall.postDtmfSpeechDelayMs, DEFAULT_GOOGLE_MEET_CONFIG.voiceCall.postDtmfSpeechDelayMs),
			introMessage: normalizeOptionalString$1(voiceCall.introMessage)
		},
		realtime: {
			provider: normalizeOptionalString$1(realtime.provider) ?? DEFAULT_GOOGLE_MEET_CONFIG.realtime.provider,
			model: normalizeOptionalString$1(realtime.model) ?? DEFAULT_GOOGLE_MEET_CONFIG.realtime.model,
			instructions: normalizeOptionalString$1(realtime.instructions) ?? DEFAULT_GOOGLE_MEET_CONFIG.realtime.instructions,
			introMessage: normalizeOptionalString$1(realtime.introMessage) ?? DEFAULT_GOOGLE_MEET_CONFIG.realtime.introMessage,
			agentId: normalizeOptionalString$1(realtime.agentId),
			toolPolicy: resolveRealtimeVoiceAgentConsultToolPolicy(realtime.toolPolicy, DEFAULT_GOOGLE_MEET_CONFIG.realtime.toolPolicy),
			providers: resolveProvidersConfig(realtime.providers)
		},
		oauth: {
			clientId: normalizeOptionalString$1(oauth.clientId) ?? normalizeOptionalString$1(auth.clientId) ?? readEnvString(env, GOOGLE_MEET_CLIENT_ID_KEYS),
			clientSecret: normalizeOptionalString$1(oauth.clientSecret) ?? normalizeOptionalString$1(auth.clientSecret) ?? readEnvString(env, GOOGLE_MEET_CLIENT_SECRET_KEYS),
			refreshToken: normalizeOptionalString$1(oauth.refreshToken) ?? readEnvString(env, GOOGLE_MEET_REFRESH_TOKEN_KEYS),
			accessToken: normalizeOptionalString$1(oauth.accessToken) ?? readEnvString(env, GOOGLE_MEET_ACCESS_TOKEN_KEYS),
			expiresAt: resolveOptionalNumber(oauth.expiresAt) ?? readEnvNumber(env, GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT_KEYS)
		},
		auth: {
			provider: "google-oauth",
			clientId: normalizeOptionalString$1(auth.clientId),
			clientSecret: normalizeOptionalString$1(auth.clientSecret),
			tokenPath: normalizeOptionalString$1(auth.tokenPath)
		}
	};
}
//#endregion
//#region extensions/google-meet/src/agent-consult.ts
const GOOGLE_MEET_AGENT_CONSULT_TOOL_NAME = REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME;
const GOOGLE_MEET_CONSULT_SYSTEM_PROMPT = [
	"You are a behind-the-scenes consultant for a live meeting voice agent.",
	"Prioritize a fast, speakable answer over exhaustive investigation.",
	"For tool-backed status checks, prefer one or two bounded read-only queries before answering.",
	"Do not print secret values or dump environment variables; only check whether required configuration is present.",
	"Be accurate, brief, and speakable."
].join(" ");
function resolveGoogleMeetRealtimeTools(policy) {
	return resolveRealtimeVoiceAgentConsultTools(policy);
}
function submitGoogleMeetConsultWorkingResponse(session, callId) {
	if (!session.bridge.supportsToolResultContinuation) return;
	session.submitToolResult(callId, buildRealtimeVoiceAgentConsultWorkingResponse("participant"), { willContinue: true });
}
async function consultOpenClawAgentForGoogleMeet(params) {
	const agentId = normalizeAgentId(params.config.realtime.agentId);
	const sessionKey = `agent:${agentId}:google-meet:${params.meetingSessionId}`;
	return await consultRealtimeVoiceAgent({
		cfg: params.fullConfig,
		agentRuntime: params.runtime.agent,
		logger: params.logger,
		agentId,
		sessionKey,
		messageProvider: "google-meet",
		lane: "google-meet",
		runIdPrefix: `google-meet:${params.meetingSessionId}`,
		args: params.args,
		transcript: params.transcript,
		surface: "a private Google Meet",
		userLabel: "Participant",
		assistantLabel: "Agent",
		questionSourceLabel: "participant",
		toolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow(params.config.realtime.toolPolicy),
		extraSystemPrompt: GOOGLE_MEET_CONSULT_SYSTEM_PROMPT
	});
}
//#endregion
//#region extensions/google-meet/src/realtime.ts
function splitCommand$1(argv) {
	const [command, ...args] = argv;
	if (!command) throw new Error("audio bridge command must not be empty");
	return {
		command,
		args
	};
}
function readPcm16Stats(audio) {
	let sumSquares = 0;
	let peak = 0;
	let samples = 0;
	for (let offset = 0; offset + 1 < audio.byteLength; offset += 2) {
		const sample = audio.readInt16LE(offset);
		peak = Math.max(peak, Math.abs(sample));
		sumSquares += sample * sample;
		samples += 1;
	}
	return {
		rms: samples > 0 ? Math.sqrt(sumSquares / samples) : 0,
		peak
	};
}
function resolveGoogleMeetRealtimeAudioFormat(config) {
	return config.chrome.audioFormat === "g711-ulaw-8khz" ? REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ : REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ;
}
function resolveGoogleMeetRealtimeProvider(params) {
	return resolveConfiguredRealtimeVoiceProvider({
		configuredProviderId: params.config.realtime.provider,
		providerConfigs: params.config.realtime.providers,
		cfg: params.fullConfig,
		providers: params.providers,
		defaultModel: params.config.realtime.model,
		noRegisteredProviderMessage: "No configured realtime voice provider registered"
	});
}
async function startCommandRealtimeAudioBridge(params) {
	const input = splitCommand$1(params.inputCommand);
	const output = splitCommand$1(params.outputCommand);
	const spawnFn = params.spawn ?? ((command, args, options) => spawn(command, args, options));
	const spawnOutputProcess = () => spawnFn(output.command, output.args, { stdio: [
		"pipe",
		"ignore",
		"pipe"
	] });
	let outputProcess = spawnOutputProcess();
	const inputProcess = spawnFn(input.command, input.args, { stdio: [
		"ignore",
		"pipe",
		"pipe"
	] });
	let stopped = false;
	let bridge = null;
	let realtimeReady = false;
	let lastInputAt;
	let lastOutputAt;
	let lastInputBytes = 0;
	let lastOutputBytes = 0;
	let lastClearAt;
	let clearCount = 0;
	let suppressedInputBytes = 0;
	let lastSuppressedInputAt;
	let suppressInputUntil = 0;
	let lastOutputAtMs = 0;
	let lastOutputPlayableUntilMs = 0;
	let bargeInInputProcess;
	const suppressInputForOutput = (audio) => {
		const bytesPerMs = params.config.chrome.audioFormat === "g711-ulaw-8khz" ? 8 : 48;
		const durationMs = Math.ceil(audio.byteLength / bytesPerMs);
		const until = Date.now() + durationMs + 900;
		suppressInputUntil = Math.max(suppressInputUntil, until);
		lastOutputPlayableUntilMs = Math.max(lastOutputPlayableUntilMs, until);
	};
	const terminateProcess = (proc, signal = "SIGTERM") => {
		if (proc.killed && signal !== "SIGKILL") return;
		let exited = false;
		proc.on("exit", () => {
			exited = true;
		});
		try {
			proc.kill(signal);
		} catch {
			return;
		}
		if (signal === "SIGKILL") return;
		setTimeout(() => {
			if (!exited) try {
				proc.kill("SIGKILL");
			} catch {}
		}, 1e3).unref?.();
	};
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		try {
			bridge?.close();
		} catch (error) {
			params.logger.debug?.(`[google-meet] realtime voice bridge close ignored: ${formatErrorMessage(error)}`);
		}
		terminateProcess(inputProcess);
		terminateProcess(outputProcess);
		if (bargeInInputProcess) terminateProcess(bargeInInputProcess);
	};
	const fail = (label) => (error) => {
		params.logger.warn(`[google-meet] ${label} failed: ${formatErrorMessage(error)}`);
		stop();
	};
	const attachOutputProcessHandlers = (proc) => {
		proc.on("error", (error) => {
			if (proc !== outputProcess) return;
			fail("audio output command")(error);
		});
		proc.on("exit", (code, signal) => {
			if (proc !== outputProcess) return;
			if (!stopped) {
				params.logger.warn(`[google-meet] audio output command exited (${code ?? signal ?? "done"})`);
				stop();
			}
		});
		proc.stderr?.on("data", (chunk) => {
			params.logger.debug?.(`[google-meet] audio output: ${String(chunk).trim()}`);
		});
	};
	const clearOutputPlayback = () => {
		if (stopped) return;
		const previousOutput = outputProcess;
		outputProcess = spawnOutputProcess();
		attachOutputProcessHandlers(outputProcess);
		clearCount += 1;
		lastClearAt = (/* @__PURE__ */ new Date()).toISOString();
		suppressInputUntil = 0;
		lastOutputPlayableUntilMs = 0;
		params.logger.debug?.(`[google-meet] cleared realtime audio output buffer by restarting playback command`);
		terminateProcess(previousOutput, "SIGKILL");
	};
	const startHumanBargeInMonitor = () => {
		const commandArgv = params.config.chrome.bargeInInputCommand;
		if (!commandArgv) return;
		const command = splitCommand$1(commandArgv);
		let lastBargeInAt = 0;
		bargeInInputProcess = spawnFn(command.command, command.args, { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		bargeInInputProcess.stdout?.on("data", (chunk) => {
			if (stopped || lastOutputAtMs === 0) return;
			const now = Date.now();
			if (!(now <= Math.max(lastOutputPlayableUntilMs, suppressInputUntil)) && now - lastOutputAtMs > 1e3) return;
			if (now - lastBargeInAt < params.config.chrome.bargeInCooldownMs) return;
			const stats = readPcm16Stats(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			if (stats.rms < params.config.chrome.bargeInRmsThreshold && stats.peak < params.config.chrome.bargeInPeakThreshold) return;
			lastBargeInAt = now;
			suppressInputUntil = 0;
			const beforeClearCount = clearCount;
			bridge?.handleBargeIn({ audioPlaybackActive: true });
			if (beforeClearCount === clearCount) clearOutputPlayback();
			params.logger.debug?.(`[google-meet] human barge-in detected by local input (rms=${Math.round(stats.rms)}, peak=${stats.peak})`);
		});
		bargeInInputProcess.stderr?.on("data", (chunk) => {
			params.logger.debug?.(`[google-meet] barge-in input: ${String(chunk).trim()}`);
		});
		bargeInInputProcess.on("error", (error) => {
			params.logger.warn(`[google-meet] human barge-in input failed: ${formatErrorMessage(error)}`);
		});
		bargeInInputProcess.on("exit", (code, signal) => {
			if (!stopped) params.logger.debug?.(`[google-meet] human barge-in input exited (${code ?? signal ?? "done"})`);
		});
	};
	inputProcess.on("error", fail("audio input command"));
	inputProcess.on("exit", (code, signal) => {
		if (!stopped) {
			params.logger.warn(`[google-meet] audio input command exited (${code ?? signal ?? "done"})`);
			stop();
		}
	});
	attachOutputProcessHandlers(outputProcess);
	inputProcess.stderr?.on("data", (chunk) => {
		params.logger.debug?.(`[google-meet] audio input: ${String(chunk).trim()}`);
	});
	const resolved = resolveGoogleMeetRealtimeProvider({
		config: params.config,
		fullConfig: params.fullConfig,
		providers: params.providers
	});
	const transcript = [];
	bridge = createRealtimeVoiceBridgeSession({
		provider: resolved.provider,
		providerConfig: resolved.providerConfig,
		audioFormat: resolveGoogleMeetRealtimeAudioFormat(params.config),
		instructions: params.config.realtime.instructions,
		initialGreetingInstructions: params.config.realtime.introMessage,
		triggerGreetingOnReady: false,
		markStrategy: "ack-immediately",
		tools: resolveGoogleMeetRealtimeTools(params.config.realtime.toolPolicy),
		audioSink: {
			isOpen: () => !stopped,
			sendAudio: (audio) => {
				lastOutputAtMs = Date.now();
				lastOutputAt = (/* @__PURE__ */ new Date()).toISOString();
				lastOutputBytes += audio.byteLength;
				suppressInputForOutput(audio);
				outputProcess.stdin?.write(audio);
			},
			clearAudio: clearOutputPlayback
		},
		onTranscript: (role, text, isFinal) => {
			if (isFinal) {
				transcript.push({
					role,
					text
				});
				if (transcript.length > 40) transcript.splice(0, transcript.length - 40);
				params.logger.debug?.(`[google-meet] ${role}: ${text}`);
			}
		},
		onToolCall: (event, session) => {
			if (event.name !== GOOGLE_MEET_AGENT_CONSULT_TOOL_NAME) {
				session.submitToolResult(event.callId || event.itemId, { error: `Tool "${event.name}" not available` });
				return;
			}
			submitGoogleMeetConsultWorkingResponse(session, event.callId || event.itemId);
			consultOpenClawAgentForGoogleMeet({
				config: params.config,
				fullConfig: params.fullConfig,
				runtime: params.runtime,
				logger: params.logger,
				meetingSessionId: params.meetingSessionId,
				args: event.args,
				transcript
			}).then((result) => {
				session.submitToolResult(event.callId || event.itemId, result);
			}).catch((error) => {
				session.submitToolResult(event.callId || event.itemId, { error: formatErrorMessage(error) });
			});
		},
		onError: fail("realtime voice bridge"),
		onClose: (reason) => {
			realtimeReady = false;
			if (reason === "error") stop();
		},
		onReady: () => {
			realtimeReady = true;
		}
	});
	startHumanBargeInMonitor();
	inputProcess.stdout?.on("data", (chunk) => {
		const audio = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		if (!stopped && audio.byteLength > 0) {
			if (Date.now() < suppressInputUntil) {
				lastSuppressedInputAt = (/* @__PURE__ */ new Date()).toISOString();
				suppressedInputBytes += audio.byteLength;
				return;
			}
			lastInputAt = (/* @__PURE__ */ new Date()).toISOString();
			lastInputBytes += audio.byteLength;
			bridge?.sendAudio(Buffer.from(audio));
		}
	});
	await bridge.connect();
	return {
		providerId: resolved.provider.id,
		inputCommand: params.inputCommand,
		outputCommand: params.outputCommand,
		speak: (instructions) => {
			bridge?.triggerGreeting(instructions);
		},
		getHealth: () => ({
			providerConnected: bridge?.bridge.isConnected() ?? false,
			realtimeReady,
			audioInputActive: lastInputBytes > 0,
			audioOutputActive: lastOutputBytes > 0,
			lastInputAt,
			lastOutputAt,
			lastSuppressedInputAt,
			lastInputBytes,
			lastOutputBytes,
			suppressedInputBytes,
			lastClearAt,
			clearCount,
			bridgeClosed: stopped
		}),
		stop
	};
}
//#endregion
//#region extensions/google-meet/src/realtime-node.ts
function asRecord$2(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function readString$1(value) {
	return typeof value === "string" && value.trim() ? value : void 0;
}
async function startNodeRealtimeAudioBridge(params) {
	let stopped = false;
	let bridge = null;
	let realtimeReady = false;
	let lastInputAt;
	let lastOutputAt;
	let lastClearAt;
	let lastInputBytes = 0;
	let lastOutputBytes = 0;
	let consecutiveInputErrors = 0;
	let lastInputError;
	let clearCount = 0;
	const resolved = resolveGoogleMeetRealtimeProvider({
		config: params.config,
		fullConfig: params.fullConfig,
		providers: params.providers
	});
	const transcript = [];
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		try {
			bridge?.close();
		} catch (error) {
			params.logger.debug?.(`[google-meet] node realtime bridge close ignored: ${formatErrorMessage(error)}`);
		}
		try {
			await params.runtime.nodes.invoke({
				nodeId: params.nodeId,
				command: "googlemeet.chrome",
				params: {
					action: "stop",
					bridgeId: params.bridgeId
				},
				timeoutMs: 5e3
			});
		} catch (error) {
			params.logger.debug?.(`[google-meet] node audio bridge stop ignored: ${formatErrorMessage(error)}`);
		}
	};
	bridge = createRealtimeVoiceBridgeSession({
		provider: resolved.provider,
		providerConfig: resolved.providerConfig,
		audioFormat: resolveGoogleMeetRealtimeAudioFormat(params.config),
		instructions: params.config.realtime.instructions,
		initialGreetingInstructions: params.config.realtime.introMessage,
		triggerGreetingOnReady: false,
		markStrategy: "ack-immediately",
		tools: resolveGoogleMeetRealtimeTools(params.config.realtime.toolPolicy),
		audioSink: {
			isOpen: () => !stopped,
			sendAudio: (audio) => {
				lastOutputAt = (/* @__PURE__ */ new Date()).toISOString();
				lastOutputBytes += audio.byteLength;
				params.runtime.nodes.invoke({
					nodeId: params.nodeId,
					command: "googlemeet.chrome",
					params: {
						action: "pushAudio",
						bridgeId: params.bridgeId,
						base64: Buffer.from(audio).toString("base64")
					},
					timeoutMs: 5e3
				}).catch((error) => {
					params.logger.warn(`[google-meet] node audio output failed: ${formatErrorMessage(error)}`);
					stop();
				});
			},
			clearAudio: () => {
				lastClearAt = (/* @__PURE__ */ new Date()).toISOString();
				clearCount += 1;
				params.runtime.nodes.invoke({
					nodeId: params.nodeId,
					command: "googlemeet.chrome",
					params: {
						action: "clearAudio",
						bridgeId: params.bridgeId
					},
					timeoutMs: 5e3
				}).catch((error) => {
					params.logger.warn(`[google-meet] node audio clear failed: ${formatErrorMessage(error)}`);
					stop();
				});
			}
		},
		onTranscript: (role, text, isFinal) => {
			if (isFinal) {
				transcript.push({
					role,
					text
				});
				if (transcript.length > 40) transcript.splice(0, transcript.length - 40);
				params.logger.debug?.(`[google-meet] ${role}: ${text}`);
			}
		},
		onToolCall: (event, session) => {
			if (event.name !== GOOGLE_MEET_AGENT_CONSULT_TOOL_NAME) {
				session.submitToolResult(event.callId || event.itemId, { error: `Tool "${event.name}" not available` });
				return;
			}
			submitGoogleMeetConsultWorkingResponse(session, event.callId || event.itemId);
			consultOpenClawAgentForGoogleMeet({
				config: params.config,
				fullConfig: params.fullConfig,
				runtime: params.runtime,
				logger: params.logger,
				meetingSessionId: params.meetingSessionId,
				args: event.args,
				transcript
			}).then((result) => {
				session.submitToolResult(event.callId || event.itemId, result);
			}).catch((error) => {
				session.submitToolResult(event.callId || event.itemId, { error: formatErrorMessage(error) });
			});
		},
		onError: (error) => {
			params.logger.warn(`[google-meet] node realtime voice bridge failed: ${formatErrorMessage(error)}`);
			stop();
		},
		onClose: (reason) => {
			realtimeReady = false;
			if (reason === "error") stop();
		},
		onReady: () => {
			realtimeReady = true;
		}
	});
	await bridge.connect();
	(async () => {
		for (;;) {
			if (stopped) break;
			try {
				const raw = await params.runtime.nodes.invoke({
					nodeId: params.nodeId,
					command: "googlemeet.chrome",
					params: {
						action: "pullAudio",
						bridgeId: params.bridgeId,
						timeoutMs: 250
					},
					timeoutMs: 2e3
				});
				const result = asRecord$2(asRecord$2(raw).payload ?? raw);
				consecutiveInputErrors = 0;
				lastInputError = void 0;
				const base64 = readString$1(result.base64);
				if (base64) {
					const audio = Buffer.from(base64, "base64");
					lastInputAt = (/* @__PURE__ */ new Date()).toISOString();
					lastInputBytes += audio.byteLength;
					bridge?.sendAudio(audio);
				}
				if (result.closed === true) await stop();
			} catch (error) {
				if (!stopped) {
					const message = formatErrorMessage(error);
					consecutiveInputErrors += 1;
					lastInputError = message;
					params.logger.warn(`[google-meet] node audio input failed (${consecutiveInputErrors}/5): ${message}`);
					if (consecutiveInputErrors >= 5 || /unknown bridgeId|bridge is not open/i.test(message)) await stop();
					else await new Promise((resolve) => setTimeout(resolve, 250));
				}
			}
		}
	})();
	return {
		type: "node-command-pair",
		providerId: resolved.provider.id,
		nodeId: params.nodeId,
		bridgeId: params.bridgeId,
		speak: (instructions) => {
			bridge?.triggerGreeting(instructions);
		},
		getHealth: () => ({
			providerConnected: bridge?.bridge.isConnected() ?? false,
			realtimeReady,
			audioInputActive: lastInputBytes > 0,
			audioOutputActive: lastOutputBytes > 0,
			lastInputAt,
			lastOutputAt,
			lastClearAt,
			lastInputBytes,
			lastOutputBytes,
			consecutiveInputErrors,
			lastInputError,
			clearCount,
			bridgeClosed: stopped
		}),
		stop
	};
}
//#endregion
//#region extensions/google-meet/src/transports/chrome.ts
const GOOGLE_MEET_SYSTEM_PROFILER_COMMAND = "/usr/sbin/system_profiler";
const chromeTransportDeps = { callGatewayFromCli };
function outputMentionsBlackHole2ch(output) {
	return /\bBlackHole\s+2ch\b/i.test(output);
}
async function assertBlackHole2chAvailable(params) {
	if (process.platform !== "darwin") throw new Error("Chrome Meet transport with blackhole-2ch audio is currently macOS-only");
	const result = await params.runtime.system.runCommandWithTimeout([GOOGLE_MEET_SYSTEM_PROFILER_COMMAND, "SPAudioDataType"], { timeoutMs: params.timeoutMs });
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	if (result.code !== 0 || !outputMentionsBlackHole2ch(output)) {
		const hint = params.runtime.system.formatNativeDependencyHint?.({
			packageName: "BlackHole 2ch",
			downloadCommand: "brew install blackhole-2ch"
		}) ?? "";
		throw new Error([
			"BlackHole 2ch audio device not found.",
			"Install BlackHole 2ch and route Chrome input/output through the OpenClaw audio bridge.",
			hint
		].filter(Boolean).join(" "));
	}
}
async function launchChromeMeet(params) {
	let audioBridge;
	if (params.mode === "realtime") {
		await assertBlackHole2chAvailable({
			runtime: params.runtime,
			timeoutMs: Math.min(params.config.chrome.joinTimeoutMs, 1e4)
		});
		if (params.config.chrome.audioBridgeHealthCommand) {
			const health = await params.runtime.system.runCommandWithTimeout(params.config.chrome.audioBridgeHealthCommand, { timeoutMs: params.config.chrome.joinTimeoutMs });
			if (health.code !== 0) throw new Error(`Chrome audio bridge health check failed: ${health.stderr || health.stdout || health.code}`);
		}
		if (params.config.chrome.audioBridgeCommand) {
			const bridge = await params.runtime.system.runCommandWithTimeout(params.config.chrome.audioBridgeCommand, { timeoutMs: params.config.chrome.joinTimeoutMs });
			if (bridge.code !== 0) throw new Error(`failed to start Chrome audio bridge: ${bridge.stderr || bridge.stdout || bridge.code}`);
			audioBridge = { type: "external-command" };
		} else {
			if (!params.config.chrome.audioInputCommand || !params.config.chrome.audioOutputCommand) throw new Error("Chrome realtime mode requires chrome.audioInputCommand and chrome.audioOutputCommand, or chrome.audioBridgeCommand for an external bridge.");
			audioBridge = {
				type: "command-pair",
				...await startCommandRealtimeAudioBridge({
					config: params.config,
					fullConfig: params.fullConfig,
					runtime: params.runtime,
					meetingSessionId: params.meetingSessionId,
					inputCommand: params.config.chrome.audioInputCommand,
					outputCommand: params.config.chrome.audioOutputCommand,
					logger: params.logger
				})
			};
		}
	}
	if (!params.config.chrome.launch) return {
		launched: false,
		audioBridge
	};
	let commandPairBridgeStopped = false;
	const stopCommandPairBridge = async () => {
		if (commandPairBridgeStopped) return;
		commandPairBridgeStopped = true;
		if (audioBridge?.type === "command-pair") await audioBridge.stop();
	};
	try {
		return {
			...await openMeetWithBrowserRequest({
				callBrowser: callLocalBrowserRequest,
				config: params.config,
				mode: params.mode,
				url: params.url
			}),
			audioBridge
		};
	} catch (error) {
		await stopCommandPairBridge();
		throw error;
	}
}
function parseNodeStartResult(raw) {
	const value = raw && typeof raw === "object" && "payload" in raw ? raw.payload : raw;
	if (!value || typeof value !== "object") throw new Error("Google Meet node returned an invalid start result.");
	return value;
}
function parseMeetBrowserStatus(result) {
	const raw = (result && typeof result === "object" ? result : {}).result;
	if (typeof raw !== "string" || !raw.trim()) return;
	const parsed = JSON.parse(raw);
	return {
		inCall: parsed.inCall,
		micMuted: parsed.micMuted,
		lobbyWaiting: parsed.lobbyWaiting,
		leaveReason: parsed.leaveReason,
		captioning: parsed.captioning,
		captionsEnabledAttempted: parsed.captionsEnabledAttempted,
		transcriptLines: parsed.transcriptLines,
		lastCaptionAt: parsed.lastCaptionAt,
		lastCaptionSpeaker: parsed.lastCaptionSpeaker,
		lastCaptionText: parsed.lastCaptionText,
		recentTranscript: parsed.recentTranscript,
		manualActionRequired: parsed.manualActionRequired,
		manualActionReason: parsed.manualActionReason,
		manualActionMessage: parsed.manualActionMessage,
		browserUrl: parsed.url,
		browserTitle: parsed.title,
		status: "browser-control",
		notes: Array.isArray(parsed.notes) ? parsed.notes.filter((note) => typeof note === "string") : void 0
	};
}
async function callLocalBrowserRequest(params) {
	return await chromeTransportDeps.callGatewayFromCli("browser.request", {
		json: true,
		timeout: String(params.timeoutMs + 5e3)
	}, {
		method: params.method,
		path: params.path,
		body: params.body,
		timeoutMs: params.timeoutMs
	}, { progress: false });
}
function mergeBrowserNotes(browser, notes) {
	if (!browser || notes.length === 0) return browser;
	return {
		...browser,
		notes: [...new Set([...browser.notes ?? [], ...notes])]
	};
}
function parsePermissionGrantNotes(result) {
	const record = result && typeof result === "object" ? result : {};
	const unsupportedPermissions = Array.isArray(record.unsupportedPermissions) ? record.unsupportedPermissions.filter((value) => typeof value === "string") : [];
	const notes = ["Granted Meet microphone/camera permissions through browser control."];
	if (unsupportedPermissions.includes("speakerSelection")) notes.push("Chrome did not accept the optional Meet speaker-selection permission.");
	return notes;
}
async function grantMeetMediaPermissions(params) {
	if (!params.allowMicrophone) return ["Observe-only mode skips Meet microphone/camera permission grants."];
	try {
		return parsePermissionGrantNotes(await params.callBrowser({
			method: "POST",
			path: "/permissions/grant",
			body: {
				origin: "https://meet.google.com",
				permissions: ["audioCapture", "videoCapture"],
				optionalPermissions: ["speakerSelection"],
				timeoutMs: Math.min(params.timeoutMs, 5e3)
			},
			timeoutMs: Math.min(params.timeoutMs, 5e3)
		}));
	} catch (error) {
		return [`Could not grant Meet media permissions automatically: ${error instanceof Error ? error.message : String(error)}`];
	}
}
function meetStatusScript(params) {
	return `() => {
  const text = (node) => (node?.innerText || node?.textContent || "").trim();
  const allowMicrophone = ${JSON.stringify(params.allowMicrophone)};
  const captureCaptions = ${JSON.stringify(params.captureCaptions)};
  const buttons = [...document.querySelectorAll('button')];
  const notes = [];
  const findButton = (pattern) =>
    buttons.find((button) => {
      const label = [
        button.getAttribute("aria-label"),
        button.getAttribute("data-tooltip"),
        text(button),
      ]
        .filter(Boolean)
        .join(" ");
      return pattern.test(label) && !button.disabled;
    });
  const input = [...document.querySelectorAll('input')].find((el) =>
    /your name/i.test(el.getAttribute('aria-label') || el.placeholder || '')
  );
  if (${JSON.stringify(params.autoJoin)} && input && !input.value) {
    input.focus();
    input.value = ${JSON.stringify(params.guestName)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const pageText = text(document.body).toLowerCase();
  const host = location.hostname.toLowerCase();
  const pageUrl = location.href;
  const permissionNeeded = /permission needed|allow.*(microphone|camera)|blocked.*(microphone|camera)|permission.*(microphone|camera|speaker)/i.test(pageText);
  const mic = buttons.find((button) => /turn off microphone|turn on microphone|microphone/i.test(button.getAttribute('aria-label') || text(button)));
  if (!allowMicrophone && mic && /turn off microphone/i.test(mic.getAttribute('aria-label') || text(mic))) {
    mic.click();
    notes.push("Muted Meet microphone for observe-only mode.");
  }
  const join = ${JSON.stringify(params.autoJoin)}
    ? findButton(/join now|ask to join/i)
    : null;
  if (join) join.click();
  const microphoneChoice = findButton(/\\buse microphone\\b/i);
  const noMicrophoneChoice = findButton(/\\b(continue|join|use) without (microphone|mic)\\b|\\bnot now\\b/i);
  if (allowMicrophone && microphoneChoice) {
    microphoneChoice.click();
    notes.push("Accepted Meet microphone prompt with browser automation.");
  } else if (!allowMicrophone && noMicrophoneChoice) {
    noMicrophoneChoice.click();
    notes.push("Skipped Meet microphone prompt for observe-only mode.");
  }
  const inCall = buttons.some((button) => /leave call/i.test(button.getAttribute('aria-label') || text(button)));
  let captioning = false;
  let captionsEnabledAttempted = false;
  let transcriptLines = 0;
  let lastCaptionAt;
  let lastCaptionSpeaker;
  let lastCaptionText;
  let recentTranscript = [];
  const captionSelector = '[role="region"][aria-label*="aption" i], [aria-live="polite"][role="region"], div[aria-live="polite"]';
  const captionState = (() => {
    if (!captureCaptions) return undefined;
    const w = window;
    if (!inCall && !w.__openclawMeetCaptions) return undefined;
    if (!w.__openclawMeetCaptions) {
      w.__openclawMeetCaptions = {
        enabledAttempted: false,
        observerInstalled: false,
        lines: [],
        seen: {}
      };
    }
    return w.__openclawMeetCaptions;
  })();
  const recordCaption = (speaker, captionText) => {
    if (!captionState) return;
    const clean = String(captionText || "").replace(/\\s+/g, " ").trim();
    const cleanSpeaker = String(speaker || "").replace(/\\s+/g, " ").trim();
    if (!clean || clean.length < 2) return;
    if (/^(turn on captions|turn off captions|captions)$/i.test(clean)) return;
    const key = (cleanSpeaker + "\\n" + clean).toLowerCase();
    if (captionState.seen[key]) return;
    captionState.seen[key] = true;
    const entry = { at: new Date().toISOString(), speaker: cleanSpeaker || undefined, text: clean };
    captionState.lines.push(entry);
    if (captionState.lines.length > 50) captionState.lines.splice(0, captionState.lines.length - 50);
  };
  const scrapeCaptions = () => {
    if (!captionState) return;
    const regions = [...document.querySelectorAll(captionSelector)];
    for (const region of regions) {
      const raw = text(region);
      if (!raw) continue;
      const pieces = raw.split(/\\n+/).map((part) => part.trim()).filter(Boolean);
      if (pieces.length >= 2) {
        recordCaption(pieces[0], pieces.slice(1).join(" "));
      } else {
        recordCaption("", pieces[0] || raw);
      }
    }
  };
  if (captionState) {
    if (inCall && !captionState.enabledAttempted) {
      const captionButton = findButton(/turn on captions|show captions|captions/i);
      const captionLabel = captionButton ? (captionButton.getAttribute("aria-label") || captionButton.getAttribute("data-tooltip") || text(captionButton)) : "";
      if (captionButton) {
        captionState.enabledAttempted = true;
        captionsEnabledAttempted = true;
        if (!/turn off captions|hide captions/i.test(captionLabel)) {
          captionButton.click();
          notes.push("Attempted to enable Meet captions for observe-only transcript health.");
        }
      }
    } else if (captionState.enabledAttempted) {
      captionsEnabledAttempted = true;
    }
    if (inCall && !captionState.observerInstalled) {
      captionState.observerInstalled = true;
      new MutationObserver(scrapeCaptions).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
      notes.push("Installed Meet caption observer for observe-only transcript health.");
    }
    if (inCall) {
      scrapeCaptions();
    }
    const lines = Array.isArray(captionState.lines) ? captionState.lines : [];
    const last = lines[lines.length - 1];
    captioning = document.querySelector(captionSelector) !== null || lines.length > 0;
    transcriptLines = lines.length;
    lastCaptionAt = last?.at;
    lastCaptionSpeaker = last?.speaker;
    lastCaptionText = last?.text;
    recentTranscript = lines.slice(-5);
  }
  const lobbyWaiting = !inCall && /asking to be let in|you.?ll join when someone lets you in|waiting to be let in|ask to join/i.test(pageText);
  const leaveReason = /you left the meeting|you.?ve left the meeting|removed from the meeting|you were removed|call ended|meeting ended/i.test(pageText)
    ? pageText.match(/you left the meeting|you.?ve left the meeting|removed from the meeting|you were removed|call ended|meeting ended/i)?.[0]
    : undefined;
  let manualActionReason;
  let manualActionMessage;
  if (!inCall && (host === "accounts.google.com" || /use your google account|to continue to google meet|choose an account|sign in to (join|continue)/i.test(pageText))) {
    manualActionReason = "google-login-required";
    manualActionMessage = "Sign in to Google in the OpenClaw browser profile, then retry the Meet join.";
  } else if (!inCall && /asking to be let in|you.?ll join when someone lets you in|waiting to be let in|ask to join/i.test(pageText)) {
    manualActionReason = "meet-admission-required";
    manualActionMessage = "Admit the OpenClaw browser participant in Google Meet, then retry speech.";
  } else if (permissionNeeded) {
    manualActionReason = "meet-permission-required";
    manualActionMessage = allowMicrophone
      ? "Allow microphone/camera/speaker permissions for Meet in the OpenClaw browser profile, then retry."
      : "Join without microphone/camera permissions in the OpenClaw browser profile, then retry.";
  } else if (!inCall && (allowMicrophone ? !microphoneChoice : !noMicrophoneChoice) && /do you want people to hear you in the meeting/i.test(pageText)) {
    manualActionReason = "meet-audio-choice-required";
    manualActionMessage = allowMicrophone
      ? "Meet is showing the microphone choice. Click Use microphone in the OpenClaw browser profile, then retry."
      : "Meet is showing the microphone choice. Choose the no-microphone option in the OpenClaw browser profile, then retry.";
  }
  return JSON.stringify({
    clickedJoin: Boolean(join),
    clickedMicrophoneChoice: Boolean(allowMicrophone && microphoneChoice),
    inCall,
    micMuted: mic ? /turn on microphone/i.test(mic.getAttribute('aria-label') || text(mic)) : undefined,
    lobbyWaiting,
    leaveReason,
    captioning,
    captionsEnabledAttempted,
    transcriptLines,
    lastCaptionAt,
    lastCaptionSpeaker,
    lastCaptionText,
    recentTranscript,
    manualActionRequired: Boolean(manualActionReason),
    manualActionReason,
    manualActionMessage,
    title: document.title,
    url: pageUrl,
    notes
  });
}`;
}
async function openMeetWithBrowserProxy(params) {
	return await openMeetWithBrowserRequest({
		callBrowser: async (request) => await callBrowserProxyOnNode({
			runtime: params.runtime,
			nodeId: params.nodeId,
			method: request.method,
			path: request.path,
			body: request.body,
			timeoutMs: request.timeoutMs
		}),
		config: params.config,
		mode: params.mode,
		url: params.url
	});
}
async function openMeetWithBrowserRequest(params) {
	if (!params.config.chrome.launch) return { launched: false };
	const timeoutMs = Math.max(1e3, params.config.chrome.joinTimeoutMs);
	let targetId;
	let tab;
	if (params.config.chrome.reuseExistingTab) {
		tab = asBrowserTabs(await params.callBrowser({
			method: "GET",
			path: "/tabs",
			timeoutMs: Math.min(timeoutMs, 5e3)
		})).find((entry) => isSameMeetUrlForReuse(entry.url, params.url));
		targetId = tab?.targetId;
		if (targetId) await params.callBrowser({
			method: "POST",
			path: "/tabs/focus",
			body: { targetId },
			timeoutMs: Math.min(timeoutMs, 5e3)
		});
	}
	if (!targetId) {
		tab = readBrowserTab(await params.callBrowser({
			method: "POST",
			path: "/tabs/open",
			body: { url: params.url },
			timeoutMs
		}));
		targetId = tab?.targetId;
	}
	if (!targetId) return {
		launched: true,
		browser: {
			status: "browser-control",
			notes: ["Browser proxy opened Meet but did not return a targetId."],
			browserUrl: tab?.url,
			browserTitle: tab?.title
		}
	};
	const permissionNotes = await grantMeetMediaPermissions({
		allowMicrophone: params.mode === "realtime",
		callBrowser: params.callBrowser,
		timeoutMs
	});
	const deadline = Date.now() + Math.max(0, params.config.chrome.waitForInCallMs);
	let browser = {
		status: "browser-control",
		browserUrl: tab?.url,
		browserTitle: tab?.title,
		notes: permissionNotes
	};
	do {
		try {
			browser = mergeBrowserNotes(parseMeetBrowserStatus(await params.callBrowser({
				method: "POST",
				path: "/act",
				body: {
					kind: "evaluate",
					targetId,
					fn: meetStatusScript({
						allowMicrophone: params.mode === "realtime",
						captureCaptions: params.mode === "transcribe",
						guestName: params.config.chrome.guestName,
						autoJoin: params.config.chrome.autoJoin
					})
				},
				timeoutMs: Math.min(timeoutMs, 1e4)
			})) ?? browser, permissionNotes);
			if (browser?.inCall === true) return {
				launched: true,
				browser
			};
			if (browser?.manualActionRequired === true) return {
				launched: true,
				browser
			};
		} catch (error) {
			browser = {
				...browser,
				inCall: false,
				manualActionRequired: true,
				manualActionReason: "browser-control-unavailable",
				manualActionMessage: "Open the OpenClaw browser profile, finish Google Meet login, admission, or permission prompts, then retry.",
				notes: [...permissionNotes, `Browser control could not inspect or auto-join Meet: ${error instanceof Error ? error.message : String(error)}`]
			};
			break;
		}
		if (Date.now() <= deadline) await new Promise((resolve) => setTimeout(resolve, 750));
	} while (Date.now() <= deadline);
	return {
		launched: true,
		browser
	};
}
function isRecoverableMeetTab(tab, url) {
	if (url) return isSameMeetUrlForReuse(tab.url, url);
	if (normalizeMeetUrlForReuse(tab.url)) return true;
	return (tab.url ?? "").startsWith("https://accounts.google.com/") && /sign in|google accounts|meet/i.test(tab.title ?? "");
}
async function inspectRecoverableMeetTab(params) {
	const allowMicrophone = params.mode !== "transcribe";
	await params.callBrowser({
		method: "POST",
		path: "/tabs/focus",
		body: { targetId: params.targetId },
		timeoutMs: Math.min(params.timeoutMs, 5e3)
	});
	const permissionNotes = await grantMeetMediaPermissions({
		allowMicrophone,
		callBrowser: params.callBrowser,
		timeoutMs: params.timeoutMs
	});
	const browser = mergeBrowserNotes(parseMeetBrowserStatus(await params.callBrowser({
		method: "POST",
		path: "/act",
		body: {
			kind: "evaluate",
			targetId: params.targetId,
			fn: meetStatusScript({
				allowMicrophone,
				captureCaptions: params.mode === "transcribe",
				guestName: params.config.chrome.guestName,
				autoJoin: false
			})
		},
		timeoutMs: Math.min(params.timeoutMs, 1e4)
	})) ?? {
		status: "browser-control",
		browserUrl: params.tab.url,
		browserTitle: params.tab.title
	}, permissionNotes);
	const manual = browser?.manualActionRequired ? browser.manualActionMessage || browser.manualActionReason : void 0;
	return {
		found: true,
		targetId: params.targetId,
		tab: params.tab,
		browser,
		message: manual ?? (browser?.inCall ? "Existing Meet tab is in-call." : "Existing Meet tab focused.")
	};
}
async function recoverCurrentMeetTab(params) {
	const timeoutMs = Math.max(1e3, params.config.chrome.joinTimeoutMs);
	const tab = asBrowserTabs(await callLocalBrowserRequest({
		method: "GET",
		path: "/tabs",
		timeoutMs: Math.min(timeoutMs, 5e3)
	})).find((entry) => isRecoverableMeetTab(entry, params.url));
	const targetId = tab?.targetId;
	if (!tab || !targetId) return {
		transport: "chrome",
		found: false,
		tab,
		message: params.url ? `No existing Meet tab matched ${params.url}.` : "No existing Meet tab found in local Chrome."
	};
	return {
		transport: "chrome",
		...await inspectRecoverableMeetTab({
			callBrowser: callLocalBrowserRequest,
			config: params.config,
			mode: params.mode,
			timeoutMs,
			tab,
			targetId
		})
	};
}
async function recoverCurrentMeetTabOnNode(params) {
	const nodeId = await resolveChromeNode({
		runtime: params.runtime,
		requestedNode: params.config.chromeNode.node
	});
	const timeoutMs = Math.max(1e3, params.config.chrome.joinTimeoutMs);
	const tab = asBrowserTabs(await callBrowserProxyOnNode({
		runtime: params.runtime,
		nodeId,
		method: "GET",
		path: "/tabs",
		timeoutMs: Math.min(timeoutMs, 5e3)
	})).find((entry) => isRecoverableMeetTab(entry, params.url));
	const targetId = tab?.targetId;
	if (!tab || !targetId) return {
		transport: "chrome-node",
		nodeId,
		found: false,
		tab,
		message: params.url ? `No existing Meet tab matched ${params.url}.` : "No existing Meet tab found on the selected Chrome node."
	};
	return {
		transport: "chrome-node",
		nodeId,
		...await inspectRecoverableMeetTab({
			callBrowser: async (request) => await callBrowserProxyOnNode({
				runtime: params.runtime,
				nodeId,
				method: request.method,
				path: request.path,
				body: request.body,
				timeoutMs: request.timeoutMs
			}),
			config: params.config,
			mode: params.mode,
			timeoutMs,
			tab,
			targetId
		})
	};
}
async function launchChromeMeetOnNode(params) {
	const nodeId = await resolveChromeNode({
		runtime: params.runtime,
		requestedNode: params.config.chromeNode.node
	});
	try {
		await params.runtime.nodes.invoke({
			nodeId,
			command: "googlemeet.chrome",
			params: {
				action: "stopByUrl",
				url: params.url,
				mode: params.mode
			},
			timeoutMs: 5e3
		});
	} catch (error) {
		params.logger.debug?.(`[google-meet] node bridge cleanup before join ignored: ${error instanceof Error ? error.message : String(error)}`);
	}
	const browserControl = await openMeetWithBrowserProxy({
		runtime: params.runtime,
		nodeId,
		config: params.config,
		mode: params.mode,
		url: params.url
	});
	const result = parseNodeStartResult(await params.runtime.nodes.invoke({
		nodeId,
		command: "googlemeet.chrome",
		params: {
			action: "start",
			url: params.url,
			mode: params.mode,
			launch: false,
			browserProfile: params.config.chrome.browserProfile,
			joinTimeoutMs: params.config.chrome.joinTimeoutMs,
			audioInputCommand: params.config.chrome.audioInputCommand,
			audioOutputCommand: params.config.chrome.audioOutputCommand,
			audioBridgeCommand: params.config.chrome.audioBridgeCommand,
			audioBridgeHealthCommand: params.config.chrome.audioBridgeHealthCommand
		},
		timeoutMs: params.config.chrome.joinTimeoutMs + 5e3
	}));
	if (result.audioBridge?.type === "node-command-pair") {
		if (!result.bridgeId) throw new Error("Google Meet node did not return an audio bridge id.");
		const bridge = await startNodeRealtimeAudioBridge({
			config: params.config,
			fullConfig: params.fullConfig,
			runtime: params.runtime,
			meetingSessionId: params.meetingSessionId,
			nodeId,
			bridgeId: result.bridgeId,
			logger: params.logger
		});
		return {
			nodeId,
			launched: browserControl.launched || result.launched === true,
			audioBridge: bridge,
			browser: browserControl.browser ?? result.browser
		};
	}
	if (result.audioBridge?.type === "external-command") return {
		nodeId,
		launched: browserControl.launched || result.launched === true,
		audioBridge: { type: "external-command" },
		browser: browserControl.browser ?? result.browser
	};
	return {
		nodeId,
		launched: browserControl.launched || result.launched === true,
		browser: browserControl.browser ?? result.browser
	};
}
//#endregion
//#region extensions/google-meet/src/node-host.ts
const sessions = /* @__PURE__ */ new Map();
function asRecord$1(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function readString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function readStringArray(value) {
	if (!Array.isArray(value)) return;
	const result = value.filter((entry) => typeof entry === "string" && entry.length > 0);
	return result.length > 0 ? result : void 0;
}
function readNumber(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
function runCommandWithTimeout(argv, timeoutMs) {
	const [command, ...args] = argv;
	if (!command) throw new Error("command must not be empty");
	const result = spawnSync(command, args, {
		encoding: "utf8",
		timeout: timeoutMs
	});
	return {
		code: typeof result.status === "number" ? result.status : result.error ? 1 : 0,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? (result.error ? formatErrorMessage(result.error) : "")
	};
}
function assertBlackHoleAvailable(timeoutMs) {
	if (process.platform !== "darwin") throw new Error("Chrome Meet transport with blackhole-2ch audio is currently macOS-only");
	const result = runCommandWithTimeout([GOOGLE_MEET_SYSTEM_PROFILER_COMMAND, "SPAudioDataType"], timeoutMs);
	const output = `${result.stdout}\n${result.stderr}`;
	if (result.code !== 0 || !outputMentionsBlackHole2ch(output)) throw new Error("BlackHole 2ch audio device not found on the node.");
}
function splitCommand(argv) {
	const [command, ...args] = argv;
	if (!command) throw new Error("audio command must not be empty");
	return {
		command,
		args
	};
}
function wake(session) {
	const waiters = session.waiters.splice(0);
	for (const waiter of waiters) waiter();
}
function stopSession(session) {
	const wasClosed = session.closed;
	session.closed = true;
	session.closedAt ??= (/* @__PURE__ */ new Date()).toISOString();
	terminateChild(session.input);
	terminateChild(session.output);
	if (!wasClosed) wake(session);
}
function attachOutputProcessHandlers(session, outputProcess) {
	outputProcess.on("exit", () => {
		if (session.output === outputProcess) stopSession(session);
	});
	outputProcess.on("error", () => {
		if (session.output === outputProcess) stopSession(session);
	});
}
function startOutputProcess(command) {
	return spawn(command.command, command.args, { stdio: [
		"pipe",
		"ignore",
		"pipe"
	] });
}
function startCommandPair(params) {
	const input = splitCommand(params.inputCommand);
	const output = splitCommand(params.outputCommand);
	const session = {
		id: `meet_node_${randomUUID()}`,
		url: params.url,
		mode: params.mode,
		outputCommand: output,
		chunks: [],
		waiters: [],
		closed: false,
		createdAt: (/* @__PURE__ */ new Date()).toISOString(),
		lastInputBytes: 0,
		lastOutputBytes: 0,
		clearCount: 0
	};
	const outputProcess = startOutputProcess(output);
	const inputProcess = spawn(input.command, input.args, { stdio: [
		"ignore",
		"pipe",
		"pipe"
	] });
	session.input = inputProcess;
	session.output = outputProcess;
	inputProcess.stdout?.on("data", (chunk) => {
		const audio = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		session.lastInputAt = (/* @__PURE__ */ new Date()).toISOString();
		session.lastInputBytes += audio.byteLength;
		session.chunks.push(audio);
		if (session.chunks.length > 200) session.chunks.splice(0, session.chunks.length - 200);
		wake(session);
	});
	inputProcess.on("exit", () => stopSession(session));
	attachOutputProcessHandlers(session, outputProcess);
	inputProcess.on("error", () => stopSession(session));
	sessions.set(session.id, session);
	return session;
}
function terminateChild(child) {
	if (!child) return;
	let exited = child.exitCode !== null || child.signalCode !== null;
	child.once?.("exit", () => {
		exited = true;
	});
	try {
		child.kill("SIGTERM");
	} catch {}
	setTimeout(() => {
		if (exited) return;
		try {
			child.kill("SIGKILL");
		} catch {}
	}, 2e3).unref?.();
}
async function pullAudio(params) {
	const bridgeId = readString(params.bridgeId);
	if (!bridgeId) throw new Error("bridgeId required");
	const session = sessions.get(bridgeId);
	if (!session) throw new Error(`unknown bridgeId: ${bridgeId}`);
	const timeoutMs = Math.min(readNumber(params.timeoutMs, 250), 2e3);
	if (session.chunks.length === 0 && !session.closed) await Promise.race([setTimeout$1(timeoutMs), new Promise((resolve) => {
		session.waiters.push(resolve);
	})]);
	const chunk = session.chunks.shift();
	return {
		bridgeId,
		closed: session.closed,
		base64: chunk ? chunk.toString("base64") : void 0
	};
}
function pushAudio(params) {
	const bridgeId = readString(params.bridgeId);
	const base64 = readString(params.base64);
	if (!bridgeId || !base64) throw new Error("bridgeId and base64 required");
	const session = sessions.get(bridgeId);
	if (!session || session.closed) throw new Error(`bridge is not open: ${bridgeId}`);
	const audio = Buffer.from(base64, "base64");
	session.lastOutputAt = (/* @__PURE__ */ new Date()).toISOString();
	session.lastOutputBytes += audio.byteLength;
	session.output?.stdin?.write(audio);
	return {
		bridgeId,
		ok: true
	};
}
function clearAudio(params) {
	const bridgeId = readString(params.bridgeId);
	if (!bridgeId) throw new Error("bridgeId required");
	const session = sessions.get(bridgeId);
	if (!session || session.closed) throw new Error(`bridge is not open: ${bridgeId}`);
	const previousOutput = session.output;
	const outputProcess = startOutputProcess(session.outputCommand);
	session.output = outputProcess;
	attachOutputProcessHandlers(session, outputProcess);
	session.clearCount += 1;
	session.lastClearAt = (/* @__PURE__ */ new Date()).toISOString();
	terminateChild(previousOutput);
	return {
		bridgeId,
		ok: true,
		clearCount: session.clearCount
	};
}
function startChrome(params) {
	const url = readString(params.url);
	if (!url) throw new Error("url required");
	const timeoutMs = readNumber(params.joinTimeoutMs, 3e4);
	const mode = readString(params.mode);
	let bridgeId;
	let audioBridge;
	if (mode === "realtime") {
		assertBlackHoleAvailable(Math.min(timeoutMs, 1e4));
		const healthCommand = readStringArray(params.audioBridgeHealthCommand);
		if (healthCommand) {
			const health = runCommandWithTimeout(healthCommand, timeoutMs);
			if (health.code !== 0) throw new Error(`Chrome audio bridge health check failed: ${health.stderr || health.stdout || health.code}`);
		}
		const bridgeCommand = readStringArray(params.audioBridgeCommand);
		if (bridgeCommand) {
			const bridge = runCommandWithTimeout(bridgeCommand, timeoutMs);
			if (bridge.code !== 0) throw new Error(`failed to start Chrome audio bridge: ${bridge.stderr || bridge.stdout || bridge.code}`);
			audioBridge = { type: "external-command" };
		} else {
			bridgeId = startCommandPair({
				inputCommand: readStringArray(params.audioInputCommand) ?? [...DEFAULT_GOOGLE_MEET_AUDIO_INPUT_COMMAND],
				outputCommand: readStringArray(params.audioOutputCommand) ?? [...DEFAULT_GOOGLE_MEET_AUDIO_OUTPUT_COMMAND],
				url,
				mode
			}).id;
			audioBridge = { type: "node-command-pair" };
		}
	}
	if (params.launch !== false) {
		const argv = [
			"open",
			"-a",
			"Google Chrome"
		];
		const browserProfile = readString(params.browserProfile);
		if (browserProfile) argv.push("--args", `--profile-directory=${browserProfile}`);
		argv.push(url);
		const result = runCommandWithTimeout(argv, timeoutMs);
		if (result.code !== 0) {
			if (bridgeId) {
				const session = sessions.get(bridgeId);
				if (session) stopSession(session);
			}
			throw new Error(`failed to launch Chrome for Meet: ${result.stderr || result.stdout || result.code}`);
		}
	}
	return {
		launched: params.launch !== false,
		bridgeId,
		audioBridge,
		browser: params.launch !== false ? {
			status: "chrome-opened",
			browserUrl: url,
			notes: ["Browser page control is handled by OpenClaw browser automation when using chrome-node."]
		} : void 0
	};
}
function bridgeStatus(params) {
	const bridgeId = readString(params.bridgeId);
	const session = bridgeId ? sessions.get(bridgeId) : void 0;
	return { bridge: session ? {
		bridgeId,
		closed: session.closed,
		createdAt: session.createdAt,
		lastInputAt: session.lastInputAt,
		lastOutputAt: session.lastOutputAt,
		lastClearAt: session.lastClearAt,
		lastInputBytes: session.lastInputBytes,
		lastOutputBytes: session.lastOutputBytes,
		clearCount: session.clearCount,
		queuedInputChunks: session.chunks.length
	} : bridgeId ? {
		bridgeId,
		closed: true
	} : void 0 };
}
function normalizeMeetKey(value) {
	if (!value) return;
	try {
		const url = new URL(value);
		if (url.hostname.toLowerCase() !== "meet.google.com") return value;
		return /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?#])/i.exec(url.pathname)?.[1]?.toLowerCase() ?? value;
	} catch {
		return value;
	}
}
function summarizeSession(session) {
	return {
		bridgeId: session.id,
		url: session.url,
		mode: session.mode,
		closed: session.closed,
		createdAt: session.createdAt,
		closedAt: session.closedAt,
		lastInputAt: session.lastInputAt,
		lastOutputAt: session.lastOutputAt,
		lastInputBytes: session.lastInputBytes,
		lastOutputBytes: session.lastOutputBytes
	};
}
function listSessions(params) {
	const urlKey = normalizeMeetKey(readString(params.url));
	const mode = readString(params.mode);
	return { bridges: [...sessions.values()].filter((session) => !session.closed).filter((session) => !urlKey || normalizeMeetKey(session.url) === urlKey).filter((session) => !mode || session.mode === mode).map(summarizeSession) };
}
function stopSessionsByUrl(params) {
	const urlKey = normalizeMeetKey(readString(params.url));
	if (!urlKey) throw new Error("url required");
	const mode = readString(params.mode);
	const exceptBridgeId = readString(params.exceptBridgeId);
	let stopped = 0;
	for (const [bridgeId, session] of sessions) {
		if (exceptBridgeId && bridgeId === exceptBridgeId) continue;
		if (normalizeMeetKey(session.url) !== urlKey) continue;
		if (mode && session.mode !== mode) continue;
		const wasClosed = session.closed;
		stopSession(session);
		sessions.delete(bridgeId);
		if (!wasClosed) stopped += 1;
	}
	return {
		ok: true,
		stopped
	};
}
function stopChrome(params) {
	const bridgeId = readString(params.bridgeId);
	if (!bridgeId) return {
		ok: true,
		stopped: false
	};
	const session = sessions.get(bridgeId);
	if (!session) return {
		ok: true,
		stopped: false
	};
	stopSession(session);
	sessions.delete(bridgeId);
	return {
		ok: true,
		stopped: true
	};
}
async function handleGoogleMeetNodeHostCommand(paramsJSON) {
	const params = asRecord$1(paramsJSON ? JSON.parse(paramsJSON) : {});
	const action = readString(params.action);
	let result;
	switch (action) {
		case "setup":
			assertBlackHoleAvailable(1e4);
			result = { ok: true };
			break;
		case "start":
			result = startChrome(params);
			break;
		case "status":
			result = bridgeStatus(params);
			break;
		case "list":
			result = listSessions(params);
			break;
		case "stopByUrl":
			result = stopSessionsByUrl(params);
			break;
		case "pullAudio":
			result = await pullAudio(params);
			break;
		case "pushAudio":
			result = pushAudio(params);
			break;
		case "clearAudio":
			result = clearAudio(params);
			break;
		case "stop":
			result = stopChrome(params);
			break;
		default: throw new Error("unsupported googlemeet.chrome action");
	}
	return JSON.stringify(result);
}
//#endregion
//#region extensions/google-meet/src/setup.ts
function resolveUserPath(input) {
	if (input === "~") return os.homedir();
	if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
	return input;
}
function isProviderUnreachableWebhookUrl(webhookUrl) {
	try {
		return isBlockedHostnameOrIp(new URL(webhookUrl).hostname);
	} catch {
		return false;
	}
}
function getVoiceCallWebhookExposureCheck(voiceCallConfig) {
	const publicUrl = normalizeOptionalString(voiceCallConfig.publicUrl);
	const tunnel = asRecord(voiceCallConfig.tunnel);
	const tailscale = asRecord(voiceCallConfig.tailscale);
	const tunnelProvider = normalizeOptionalString(tunnel.provider);
	const tailscaleMode = normalizeOptionalString(tailscale.mode);
	if (publicUrl) {
		const ok = !isProviderUnreachableWebhookUrl(publicUrl);
		return {
			id: "twilio-voice-call-webhook",
			ok,
			message: ok ? `Voice-call public webhook URL configured: ${publicUrl}` : `Voice-call publicUrl is local/private and cannot be reached by Twilio: ${publicUrl}`
		};
	}
	if (tunnelProvider && tunnelProvider !== "none") return {
		id: "twilio-voice-call-webhook",
		ok: true,
		message: "Voice-call webhook exposure configured through tunnel"
	};
	if (tailscaleMode && tailscaleMode !== "off") return {
		id: "twilio-voice-call-webhook",
		ok: true,
		message: "Voice-call webhook exposure configured through Tailscale"
	};
	return {
		id: "twilio-voice-call-webhook",
		ok: false,
		message: "Set plugins.entries.voice-call.config.publicUrl or configure voice-call tunnel/tailscale exposure for Twilio dialing"
	};
}
function getGoogleMeetSetupStatus(config, options) {
	const checks = [];
	const env = options?.env ?? process.env;
	const fullConfig = asRecord(options?.fullConfig);
	const mode = options?.mode ?? config.defaultMode;
	const transport = options?.transport ?? config.defaultTransport;
	const needsChromeRealtimeAudio = mode === "realtime" && (transport === "chrome" || transport === "chrome-node");
	const pluginEntries = asRecord(asRecord(fullConfig.plugins).entries);
	const pluginAllow = asRecord(fullConfig.plugins).allow;
	const voiceCallEntry = asRecord(pluginEntries["voice-call"]);
	const voiceCallConfig = asRecord(voiceCallEntry.config);
	const voiceCallTwilioConfig = asRecord(voiceCallConfig.twilio);
	if (config.auth.tokenPath) {
		const tokenPath = resolveUserPath(config.auth.tokenPath);
		checks.push({
			id: "google-oauth-token",
			ok: fs.existsSync(tokenPath),
			message: fs.existsSync(tokenPath) ? "Google OAuth token file found" : `Google OAuth token file missing at ${config.auth.tokenPath}`
		});
	} else checks.push({
		id: "google-oauth-token",
		ok: true,
		message: "Google OAuth token path not configured; Chrome profile auth will be used"
	});
	checks.push({
		id: "chrome-profile",
		ok: true,
		message: config.chrome.browserProfile ? "Local Chrome uses the OpenClaw browser profile; chrome.browserProfile is passed to chrome-node hosts" : "Local Chrome uses the OpenClaw browser profile; configure browser.defaultProfile to choose another profile"
	});
	if (needsChromeRealtimeAudio) checks.push({
		id: "audio-bridge",
		ok: Boolean(config.chrome.audioBridgeCommand || config.chrome.audioInputCommand && config.chrome.audioOutputCommand),
		message: config.chrome.audioBridgeCommand ? "Chrome audio bridge command configured" : config.chrome.audioInputCommand && config.chrome.audioOutputCommand ? `Chrome command-pair realtime audio bridge configured (${config.chrome.audioFormat})` : "Chrome realtime audio bridge not configured"
	});
	else if (transport === "chrome" || transport === "chrome-node") checks.push({
		id: "audio-bridge",
		ok: true,
		message: "Chrome observe-only mode does not require a realtime audio bridge"
	});
	checks.push({
		id: "guest-join-defaults",
		ok: Boolean(config.chrome.guestName && config.chrome.autoJoin && config.chrome.reuseExistingTab),
		message: config.chrome.guestName && config.chrome.autoJoin && config.chrome.reuseExistingTab ? "Guest auto-join and tab reuse defaults are enabled" : "Set chrome.guestName, chrome.autoJoin, and chrome.reuseExistingTab for unattended guest joins"
	});
	checks.push({
		id: "chrome-node-target",
		ok: config.defaultTransport !== "chrome-node" || Boolean(config.chromeNode.node),
		message: config.defaultTransport === "chrome-node" && !config.chromeNode.node ? "chrome-node default should pin chromeNode.node when multiple nodes may be connected" : config.chromeNode.node ? `Chrome node pinned to ${config.chromeNode.node}` : "Chrome node not pinned; automatic selection works when exactly one capable node is connected"
	});
	if (needsChromeRealtimeAudio) checks.push({
		id: "intro-after-in-call",
		ok: config.chrome.waitForInCallMs > 0,
		message: config.chrome.waitForInCallMs > 0 ? `Realtime intro waits up to ${config.chrome.waitForInCallMs}ms for the Meet tab to be in-call` : "Set chrome.waitForInCallMs to delay realtime intro until the Meet tab is in-call"
	});
	if (transport === "twilio") {
		const hasRequestDialPlan = Boolean(options?.twilioDialInNumber);
		const hasDefaultDialPlan = Boolean(config.twilio.defaultDialInNumber);
		const hasDialPlan = hasRequestDialPlan || hasDefaultDialPlan;
		checks.push({
			id: "twilio-dial-plan",
			ok: hasDialPlan,
			message: hasRequestDialPlan ? "Twilio request includes a Meet dial-in number" : hasDefaultDialPlan ? "Twilio default Meet dial-in number is configured" : "Twilio joins require a Meet dial-in phone number; pass dialInNumber with optional pin/dtmfSequence or configure twilio.defaultDialInNumber"
		});
	}
	if (config.voiceCall.enabled && (transport === "twilio" || Boolean(config.twilio.defaultDialInNumber) || Object.hasOwn(pluginEntries, "voice-call"))) {
		const voiceCallAllowed = !Array.isArray(pluginAllow) || pluginAllow.includes("voice-call");
		const voiceCallEnabled = voiceCallEntry.enabled !== false;
		checks.push({
			id: "twilio-voice-call-plugin",
			ok: voiceCallAllowed && voiceCallEnabled,
			message: voiceCallAllowed && voiceCallEnabled ? "Twilio transport can delegate dialing to the voice-call plugin" : "Enable plugins.entries.voice-call and include voice-call in plugins.allow for Twilio dialing"
		});
		if ((normalizeOptionalString(voiceCallConfig.provider) ?? "twilio") === "twilio") {
			const accountSid = normalizeOptionalString(voiceCallTwilioConfig.accountSid);
			const authToken = normalizeOptionalString(voiceCallTwilioConfig.authToken);
			const fromNumber = normalizeOptionalString(voiceCallConfig.fromNumber);
			const twilioReady = Boolean((accountSid || env.TWILIO_ACCOUNT_SID) && (authToken || env.TWILIO_AUTH_TOKEN) && (fromNumber || env.TWILIO_FROM_NUMBER));
			checks.push({
				id: "twilio-voice-call-credentials",
				ok: twilioReady,
				message: twilioReady ? "Twilio voice-call credentials are configured" : "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER or configure voice-call Twilio credentials"
			});
			checks.push(getVoiceCallWebhookExposureCheck(voiceCallConfig));
		}
	}
	return {
		ok: checks.every((check) => check.ok),
		checks
	};
}
function addGoogleMeetSetupCheck(status, check) {
	const checks = [...status.checks, check];
	return {
		ok: checks.every((item) => item.ok),
		checks
	};
}
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function normalizeOptionalString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
//#endregion
//#region extensions/google-meet/src/transports/twilio.ts
const DTMF_PATTERN = /^[0-9*#wWpP,]+$/;
function normalizeDialInNumber(value) {
	const normalized = normalizeOptionalString$1(value);
	if (!normalized) return;
	const compact = normalized.replace(/[()\s.-]/g, "");
	if (!/^\+?[0-9]{5,20}$/.test(compact)) throw new Error("dialInNumber must be a phone number");
	return compact;
}
function normalizeDtmfSequence(value) {
	const normalized = normalizeOptionalString$1(value);
	if (!normalized) return;
	const compact = normalized.replace(/\s+/g, "");
	if (!DTMF_PATTERN.test(compact)) throw new Error("dtmfSequence may only contain digits, *, #, comma, w, p");
	return compact;
}
function buildMeetDtmfSequence(params) {
	const explicit = normalizeDtmfSequence(params.dtmfSequence);
	if (explicit) return explicit;
	const pin = normalizeOptionalString$1(params.pin);
	if (!pin) return;
	const compactPin = pin.replace(/\s+/g, "");
	if (!/^[0-9]+#?$/.test(compactPin)) throw new Error("pin may only contain digits and an optional trailing #");
	return compactPin.endsWith("#") ? compactPin : `${compactPin}#`;
}
//#endregion
//#region extensions/google-meet/src/voice-call-gateway.ts
function sleep$1(ms) {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => setTimeout(resolve, ms));
}
async function createConnectedGatewayClient(config) {
	let client;
	await new Promise((resolve, reject) => {
		const abortStart = new AbortController();
		const timer = setTimeout(() => {
			abortStart.abort();
			reject(/* @__PURE__ */ new Error("gateway connect timeout"));
		}, config.voiceCall.requestTimeoutMs);
		client = new GatewayClient({
			url: config.voiceCall.gatewayUrl,
			token: config.voiceCall.token,
			requestTimeoutMs: config.voiceCall.requestTimeoutMs,
			clientName: "cli",
			clientDisplayName: "Google Meet plugin",
			scopes: ["operator.write"],
			onHelloOk: () => {
				clearTimeout(timer);
				resolve();
			},
			onConnectError: (err) => {
				clearTimeout(timer);
				abortStart.abort();
				reject(err);
			}
		});
		startGatewayClientWhenEventLoopReady(client, {
			timeoutMs: config.voiceCall.requestTimeoutMs,
			signal: abortStart.signal
		}).then((readiness) => {
			if (!readiness.ready && !readiness.aborted) {
				clearTimeout(timer);
				reject(/* @__PURE__ */ new Error("gateway event loop readiness timeout"));
			}
		}).catch((err) => {
			clearTimeout(timer);
			reject(err instanceof Error ? err : new Error(String(err)));
		});
	});
	return client;
}
async function joinMeetViaVoiceCallGateway(params) {
	let client;
	try {
		client = await createConnectedGatewayClient(params.config);
		params.logger?.info(`[google-meet] Delegating Twilio join to Voice Call (dtmf=${params.dtmfSequence ? "post-connect" : "none"}, intro=${params.message ? "delayed" : "none"})`);
		const start = await client.request("voicecall.start", {
			to: params.dialInNumber,
			mode: "conversation"
		}, { timeoutMs: params.config.voiceCall.requestTimeoutMs });
		if (!start.callId) throw new Error(start.error || "voicecall.start did not return callId");
		params.logger?.info(`[google-meet] Voice Call Twilio phone leg started: callId=${start.callId}`);
		let dtmfSent = false;
		if (params.dtmfSequence) {
			const delayMs = params.config.voiceCall.dtmfDelayMs;
			params.logger?.info(`[google-meet] Waiting ${delayMs}ms before sending Meet DTMF for callId=${start.callId}`);
			await sleep$1(delayMs);
			const dtmf = await client.request("voicecall.dtmf", {
				callId: start.callId,
				digits: params.dtmfSequence
			}, { timeoutMs: params.config.voiceCall.requestTimeoutMs });
			if (dtmf.success === false) throw new Error(dtmf.error || "voicecall.dtmf failed");
			dtmfSent = true;
			params.logger?.info(`[google-meet] Meet DTMF sent after phone leg connected: callId=${start.callId} digits=${params.dtmfSequence.length}`);
		}
		let introSent = false;
		if (params.message) {
			const delayMs = params.dtmfSequence ? params.config.voiceCall.postDtmfSpeechDelayMs : 0;
			if (delayMs > 0) {
				params.logger?.info(`[google-meet] Waiting ${delayMs}ms after Meet DTMF before speaking intro for callId=${start.callId}`);
				await sleep$1(delayMs);
			}
			const spoken = await client.request("voicecall.speak", {
				callId: start.callId,
				message: params.message
			}, { timeoutMs: params.config.voiceCall.requestTimeoutMs });
			if (spoken.success === false) throw new Error(spoken.error || "voicecall.speak failed");
			introSent = true;
			params.logger?.info(`[google-meet] Intro speech requested after Meet dial sequence: callId=${start.callId}`);
		}
		return {
			callId: start.callId,
			dtmfSent,
			introSent
		};
	} finally {
		await client?.stopAndWait({ timeoutMs: 1e3 });
	}
}
async function endMeetVoiceCallGatewayCall(params) {
	let client;
	try {
		client = await createConnectedGatewayClient(params.config);
		await client.request("voicecall.end", { callId: params.callId }, { timeoutMs: params.config.voiceCall.requestTimeoutMs });
	} finally {
		await client?.stopAndWait({ timeoutMs: 1e3 });
	}
}
async function speakMeetViaVoiceCallGateway(params) {
	let client;
	try {
		client = await createConnectedGatewayClient(params.config);
		const spoken = await client.request("voicecall.speak", {
			callId: params.callId,
			message: params.message
		}, { timeoutMs: params.config.voiceCall.requestTimeoutMs });
		if (spoken.success === false) throw new Error(spoken.error || "voicecall.speak failed");
	} finally {
		await client?.stopAndWait({ timeoutMs: 1e3 });
	}
}
//#endregion
//#region extensions/google-meet/src/runtime.ts
function nowIso() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function normalizeMeetUrl(input) {
	const raw = normalizeOptionalString$1(input);
	if (!raw) throw new Error("url required");
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("url must be a valid Google Meet URL");
	}
	if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "meet.google.com") throw new Error("url must be an explicit https://meet.google.com/... URL");
	if (!/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:$|[/?#])/i.test(url.pathname)) throw new Error("url must include a Google Meet meeting code");
	return url.toString();
}
function resolveTransport(input, config) {
	return input ?? config.defaultTransport;
}
function resolveMode(input, config) {
	return input ?? config.defaultMode;
}
function hasRealtimeAudioOutputAdvanced(health, startOutputBytes) {
	return (health?.lastOutputBytes ?? 0) > startOutputBytes;
}
function transcriptCheckpoint(health) {
	return {
		lines: health?.transcriptLines ?? 0,
		lastCaptionAt: health?.lastCaptionAt,
		lastCaptionText: health?.lastCaptionText
	};
}
function hasTranscriptAdvanced(health, start) {
	if ((health?.transcriptLines ?? 0) > start.lines) return true;
	if (health?.lastCaptionAt && health.lastCaptionAt !== start.lastCaptionAt) return true;
	return Boolean(health?.lastCaptionText && health.lastCaptionText !== start.lastCaptionText);
}
function resolveProbeTimeoutMs(input, fallback) {
	if (input === void 0) return Math.min(Math.max(fallback, 1), 12e4);
	if (!Number.isFinite(input) || input <= 0) throw new Error("timeoutMs must be a positive number");
	return Math.min(Math.trunc(input), 12e4);
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
function isManagedChromeBrowserSession(session) {
	return Boolean((session.transport === "chrome" || session.transport === "chrome-node") && session.chrome && session.chrome.launched);
}
function evaluateSpeechReadiness(session) {
	if (session.mode !== "realtime" || !session.chrome) return { ready: true };
	if (!isManagedChromeBrowserSession(session)) {
		if (session.chrome.audioBridge) return { ready: true };
		return {
			ready: false,
			reason: "audio-bridge-unavailable",
			message: "Realtime speech requires an active Chrome audio bridge."
		};
	}
	const health = session.chrome.health;
	if (health?.manualActionRequired) return {
		ready: false,
		reason: health.manualActionReason ?? "browser-unverified",
		message: health.manualActionMessage ?? "Resolve the Google Meet browser prompt before asking OpenClaw to speak."
	};
	if (health?.inCall === true) {
		if (session.chrome.audioBridge) return { ready: true };
		return {
			ready: false,
			reason: "audio-bridge-unavailable",
			message: "Realtime speech requires an active Chrome audio bridge."
		};
	}
	if (health?.inCall === false) return {
		ready: false,
		reason: "not-in-call",
		message: "Google Meet has not reported that the browser participant is in the call."
	};
	return {
		ready: false,
		reason: "browser-unverified",
		message: "Google Meet browser state has not been verified yet."
	};
}
function collectChromeAudioCommands(config) {
	const commands = config.chrome.audioBridgeCommand ? [config.chrome.audioBridgeCommand[0]] : [
		config.chrome.audioInputCommand?.[0],
		config.chrome.audioOutputCommand?.[0],
		config.chrome.bargeInInputCommand?.[0]
	];
	return [...new Set(commands.filter((value) => Boolean(value?.trim())))];
}
async function commandExists(runtime, command) {
	return (await runtime.system.runCommandWithTimeout([
		"/bin/sh",
		"-lc",
		"command -v \"$1\" >/dev/null 2>&1",
		"sh",
		command
	], { timeoutMs: 5e3 })).code === 0;
}
var GoogleMeetRuntime = class {
	#sessions = /* @__PURE__ */ new Map();
	#sessionStops = /* @__PURE__ */ new Map();
	#sessionSpeakers = /* @__PURE__ */ new Map();
	#sessionHealth = /* @__PURE__ */ new Map();
	constructor(params) {
		this.params = params;
	}
	list() {
		this.#refreshHealth();
		return [...this.#sessions.values()].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	async status(sessionId) {
		this.#refreshHealth(sessionId);
		if (!sessionId) {
			const sessions = [...this.#sessions.values()].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
			await Promise.all(sessions.map((session) => this.#refreshCaptionHealthForSession(session)));
			return {
				found: true,
				sessions
			};
		}
		const session = this.#sessions.get(sessionId);
		if (session) await this.#refreshCaptionHealthForSession(session);
		return session ? {
			found: true,
			session
		} : { found: false };
	}
	async setupStatus(options = {}) {
		const transport = resolveTransport(options.transport, this.params.config);
		const mode = resolveMode(options.mode, this.params.config);
		const twilioDialInNumber = transport === "twilio" ? normalizeDialInNumber(options.dialInNumber) : void 0;
		const shouldCheckChromeNode = transport === "chrome-node" || !options.transport && Boolean(this.params.config.chromeNode.node);
		let status = getGoogleMeetSetupStatus(this.params.config, {
			fullConfig: this.params.fullConfig,
			mode,
			transport,
			twilioDialInNumber
		});
		if (shouldCheckChromeNode) try {
			const node = await resolveChromeNodeInfo({
				runtime: this.params.runtime,
				requestedNode: this.params.config.chromeNode.node
			});
			const label = node.displayName ?? node.remoteIp ?? node.nodeId ?? "connected node";
			status = addGoogleMeetSetupCheck(status, {
				id: "chrome-node-connected",
				ok: true,
				message: `Connected Google Meet node ready: ${label}`
			});
		} catch (error) {
			status = addGoogleMeetSetupCheck(status, {
				id: "chrome-node-connected",
				ok: false,
				message: formatErrorMessage(error)
			});
		}
		if (transport === "chrome" && mode === "realtime") {
			try {
				await assertBlackHole2chAvailable({
					runtime: this.params.runtime,
					timeoutMs: Math.min(this.params.config.chrome.joinTimeoutMs, 1e4)
				});
				status = addGoogleMeetSetupCheck(status, {
					id: "chrome-local-audio-device",
					ok: true,
					message: "BlackHole 2ch audio device found"
				});
			} catch (error) {
				status = addGoogleMeetSetupCheck(status, {
					id: "chrome-local-audio-device",
					ok: false,
					message: formatErrorMessage(error)
				});
			}
			const commands = collectChromeAudioCommands(this.params.config);
			const missingCommands = [];
			for (const command of commands) try {
				if (!await commandExists(this.params.runtime, command)) missingCommands.push(command);
			} catch {
				missingCommands.push(command);
			}
			status = addGoogleMeetSetupCheck(status, {
				id: "chrome-local-audio-commands",
				ok: commands.length > 0 && missingCommands.length === 0,
				message: commands.length === 0 ? "Chrome realtime audio commands are not configured" : missingCommands.length === 0 ? `Chrome audio command${commands.length === 1 ? "" : "s"} available: ${commands.join(", ")}` : `Chrome audio command${missingCommands.length === 1 ? "" : "s"} missing: ${missingCommands.join(", ")}`
			});
		}
		return status;
	}
	async createViaBrowser() {
		return createMeetWithBrowserProxyOnNode({
			runtime: this.params.runtime,
			config: this.params.config
		});
	}
	async recoverCurrentTab(request = {}) {
		const transport = resolveTransport(request.transport, this.params.config);
		if (transport === "twilio") throw new Error("recover_current_tab only supports chrome or chrome-node transports");
		const url = request.url ? normalizeMeetUrl(request.url) : void 0;
		if (transport === "chrome-node") return recoverCurrentMeetTabOnNode({
			runtime: this.params.runtime,
			config: this.params.config,
			url
		});
		return recoverCurrentMeetTab({
			config: this.params.config,
			url
		});
	}
	async join(request) {
		const url = normalizeMeetUrl(request.url);
		const transport = resolveTransport(request.transport, this.params.config);
		const mode = resolveMode(request.mode, this.params.config);
		const reusable = this.list().find((session) => session.state === "active" && isSameMeetUrlForReuse(session.url, url) && session.transport === transport && session.mode === mode);
		const speechInstructions = request.message ?? this.params.config.realtime.introMessage;
		if (reusable) {
			await this.#refreshBrowserHealthForChromeSession(reusable);
			reusable.notes = [...reusable.notes.filter((note) => note !== "Reused existing active Meet session."), "Reused existing active Meet session."];
			reusable.updatedAt = nowIso();
			return {
				session: reusable,
				spoken: mode === "realtime" && speechInstructions ? (await this.speak(reusable.id, speechInstructions)).spoken : false
			};
		}
		const createdAt = nowIso();
		let delegatedTwilioSpoken = false;
		const session = {
			id: `meet_${randomUUID()}`,
			url,
			transport,
			mode,
			state: "active",
			createdAt,
			updatedAt: createdAt,
			participantIdentity: transport === "twilio" ? "Twilio phone participant" : transport === "chrome-node" ? "signed-in Google Chrome profile on a paired node" : "signed-in Google Chrome profile",
			realtime: {
				enabled: mode === "realtime",
				provider: this.params.config.realtime.provider,
				model: this.params.config.realtime.model,
				toolPolicy: this.params.config.realtime.toolPolicy
			},
			notes: []
		};
		try {
			if (transport === "chrome" || transport === "chrome-node") {
				const result = transport === "chrome-node" ? await launchChromeMeetOnNode({
					runtime: this.params.runtime,
					config: this.params.config,
					fullConfig: this.params.fullConfig,
					meetingSessionId: session.id,
					mode,
					url,
					logger: this.params.logger
				}) : await launchChromeMeet({
					runtime: this.params.runtime,
					config: this.params.config,
					fullConfig: this.params.fullConfig,
					meetingSessionId: session.id,
					mode,
					url,
					logger: this.params.logger
				});
				session.chrome = {
					audioBackend: this.params.config.chrome.audioBackend,
					launched: result.launched,
					nodeId: "nodeId" in result ? result.nodeId : void 0,
					browserProfile: this.params.config.chrome.browserProfile,
					audioBridge: result.audioBridge ? {
						type: result.audioBridge.type,
						provider: result.audioBridge.type === "command-pair" || result.audioBridge.type === "node-command-pair" ? result.audioBridge.providerId : void 0
					} : void 0,
					health: "browser" in result ? result.browser : void 0
				};
				if (result.audioBridge?.type === "command-pair" || result.audioBridge?.type === "node-command-pair") {
					this.#sessionStops.set(session.id, result.audioBridge.stop);
					this.#sessionSpeakers.set(session.id, result.audioBridge.speak);
					this.#sessionHealth.set(session.id, result.audioBridge.getHealth);
				}
				session.notes.push(result.audioBridge ? transport === "chrome-node" ? "Chrome node transport joins as the signed-in Google profile on the selected node and routes realtime audio through the node bridge." : "Chrome transport joins as the signed-in Google profile and routes realtime audio through the configured bridge." : mode === "realtime" ? "Chrome transport joins as the signed-in Google profile and expects BlackHole 2ch audio routing." : "Chrome transport joins as the signed-in Google profile without starting the realtime audio bridge.");
				this.#refreshSpeechReadiness(session);
			} else {
				const dialInNumber = normalizeDialInNumber(request.dialInNumber ?? this.params.config.twilio.defaultDialInNumber);
				if (!dialInNumber) throw new Error("Twilio transport requires a Meet dial-in phone number. Google Meet URLs do not include dial-in details; pass dialInNumber with optional pin/dtmfSequence, configure twilio.defaultDialInNumber, or use chrome/chrome-node transport.");
				const dtmfSequence = buildMeetDtmfSequence({
					pin: request.pin ?? this.params.config.twilio.defaultPin,
					dtmfSequence: request.dtmfSequence ?? this.params.config.twilio.defaultDtmfSequence
				});
				const voiceCallResult = this.params.config.voiceCall.enabled ? await joinMeetViaVoiceCallGateway({
					config: this.params.config,
					dialInNumber,
					dtmfSequence,
					logger: this.params.logger,
					message: mode === "realtime" ? request.message ?? this.params.config.voiceCall.introMessage ?? this.params.config.realtime.introMessage : void 0
				}) : void 0;
				delegatedTwilioSpoken = Boolean(voiceCallResult?.introSent);
				session.twilio = {
					dialInNumber,
					pinProvided: Boolean(request.pin ?? this.params.config.twilio.defaultPin),
					dtmfSequence,
					voiceCallId: voiceCallResult?.callId,
					dtmfSent: voiceCallResult?.dtmfSent,
					introSent: voiceCallResult?.introSent
				};
				if (voiceCallResult?.callId) this.#sessionStops.set(session.id, async () => {
					await endMeetVoiceCallGatewayCall({
						config: this.params.config,
						callId: voiceCallResult.callId
					});
				});
				session.notes.push(this.params.config.voiceCall.enabled ? dtmfSequence ? "Twilio transport delegated the phone leg to the voice-call plugin, then sent configured DTMF after connect before speaking." : "Twilio transport delegated the call to the voice-call plugin without configured DTMF." : "Twilio transport is an explicit dial plan; voice-call delegation is disabled.");
			}
		} catch (err) {
			this.params.logger.warn(`[google-meet] join failed: ${formatErrorMessage(err)}`);
			throw err;
		}
		this.#sessions.set(session.id, session);
		return {
			session,
			spoken: transport === "twilio" ? delegatedTwilioSpoken : mode === "realtime" && speechInstructions ? (await this.speak(session.id, speechInstructions)).spoken : false
		};
	}
	async leave(sessionId) {
		const session = this.#sessions.get(sessionId);
		if (!session) return { found: false };
		const stop = this.#sessionStops.get(sessionId);
		if (stop) {
			this.#sessionStops.delete(sessionId);
			this.#sessionSpeakers.delete(sessionId);
			this.#sessionHealth.delete(sessionId);
			await stop();
		}
		session.state = "ended";
		session.updatedAt = nowIso();
		return {
			found: true,
			session
		};
	}
	async speak(sessionId, instructions) {
		const session = this.#sessions.get(sessionId);
		if (!session) return {
			found: false,
			spoken: false
		};
		if (session.transport === "twilio" && session.twilio?.voiceCallId) {
			await speakMeetViaVoiceCallGateway({
				config: this.params.config,
				callId: session.twilio.voiceCallId,
				message: instructions || this.params.config.voiceCall.introMessage || this.params.config.realtime.introMessage || ""
			});
			session.twilio.introSent = true;
			session.updatedAt = nowIso();
			return {
				found: true,
				spoken: true,
				session
			};
		}
		await this.#refreshBrowserHealthForChromeSession(session);
		const speak = this.#sessionSpeakers.get(sessionId);
		if (!speak || session.state !== "active") return {
			found: true,
			spoken: false,
			session
		};
		const readiness = this.#refreshSpeechReadiness(session);
		if (!readiness.ready) {
			const note = readiness.message ? `Realtime speech blocked: ${readiness.message}` : "Realtime speech blocked until Google Meet is ready.";
			session.notes = [...session.notes.filter((item) => item !== note), note];
			session.updatedAt = nowIso();
			return {
				found: true,
				spoken: false,
				session
			};
		}
		speak(instructions || this.params.config.realtime.introMessage);
		session.updatedAt = nowIso();
		this.#refreshHealth(sessionId);
		return {
			found: true,
			spoken: true,
			session
		};
	}
	async testSpeech(request) {
		if (request.mode === "transcribe") throw new Error("test_speech requires mode: realtime; use join mode: transcribe for observe-only sessions.");
		const url = normalizeMeetUrl(request.url);
		const transport = resolveTransport(request.transport, this.params.config);
		const beforeSessions = this.list();
		const before = new Set(beforeSessions.map((session) => session.id));
		const startOutputBytes = beforeSessions.find((session) => session.state === "active" && isSameMeetUrlForReuse(session.url, url) && session.transport === transport && session.mode === "realtime")?.chrome?.health?.lastOutputBytes ?? 0;
		const result = await this.join({
			...request,
			transport,
			url,
			mode: "realtime",
			message: request.message ?? "Say exactly: Google Meet speech test complete."
		});
		let health = result.session.chrome?.health;
		const shouldWaitForOutput = result.spoken === true && health?.manualActionRequired !== true && this.#sessionHealth.has(result.session.id);
		if (shouldWaitForOutput && !hasRealtimeAudioOutputAdvanced(health, startOutputBytes)) {
			const deadline = Date.now() + Math.min(this.params.config.chrome.joinTimeoutMs, 5e3);
			while (Date.now() < deadline) {
				await sleep(100);
				this.#refreshHealth(result.session.id);
				health = result.session.chrome?.health;
				if (hasRealtimeAudioOutputAdvanced(health, startOutputBytes)) break;
			}
		}
		const speechOutputVerified = hasRealtimeAudioOutputAdvanced(health, startOutputBytes);
		return {
			createdSession: !before.has(result.session.id),
			inCall: health?.inCall,
			manualActionRequired: health?.manualActionRequired,
			manualActionReason: health?.manualActionReason,
			manualActionMessage: health?.manualActionMessage,
			spoken: result.spoken ?? false,
			speechOutputVerified,
			speechOutputTimedOut: shouldWaitForOutput && !speechOutputVerified,
			speechReady: health?.speechReady,
			speechBlockedReason: health?.speechBlockedReason,
			speechBlockedMessage: health?.speechBlockedMessage,
			audioOutputActive: health?.audioOutputActive,
			lastOutputBytes: health?.lastOutputBytes,
			session: result.session
		};
	}
	async testListen(request) {
		if (request.mode === "realtime") throw new Error("test_listen requires mode: transcribe; use test_speech for realtime talk-back.");
		const url = normalizeMeetUrl(request.url);
		const transport = resolveTransport(request.transport, this.params.config);
		if (transport === "twilio") throw new Error("test_listen supports chrome or chrome-node transports");
		const beforeSessions = this.list();
		const before = new Set(beforeSessions.map((session) => session.id));
		const start = transcriptCheckpoint(beforeSessions.find((session) => session.state === "active" && isSameMeetUrlForReuse(session.url, url) && session.transport === transport && session.mode === "transcribe")?.chrome?.health);
		const result = await this.join({
			...request,
			transport,
			url,
			mode: "transcribe",
			message: void 0
		});
		let health = result.session.chrome?.health;
		const timeoutMs = resolveProbeTimeoutMs(request.timeoutMs, this.params.config.chrome.joinTimeoutMs);
		const shouldWait = health?.manualActionRequired !== true && isManagedChromeBrowserSession(result.session);
		if (shouldWait && !hasTranscriptAdvanced(health, start)) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				await sleep(250);
				await this.#refreshCaptionHealthForSession(result.session);
				health = result.session.chrome?.health;
				if (health?.manualActionRequired || hasTranscriptAdvanced(health, start)) break;
			}
		}
		const listenVerified = hasTranscriptAdvanced(health, start);
		return {
			createdSession: !before.has(result.session.id),
			inCall: health?.inCall,
			manualActionRequired: health?.manualActionRequired,
			manualActionReason: health?.manualActionReason,
			manualActionMessage: health?.manualActionMessage,
			listenVerified,
			listenTimedOut: shouldWait && !listenVerified && health?.manualActionRequired !== true,
			captioning: health?.captioning,
			captionsEnabledAttempted: health?.captionsEnabledAttempted,
			transcriptLines: health?.transcriptLines,
			lastCaptionAt: health?.lastCaptionAt,
			lastCaptionSpeaker: health?.lastCaptionSpeaker,
			lastCaptionText: health?.lastCaptionText,
			recentTranscript: health?.recentTranscript,
			session: result.session
		};
	}
	async #refreshCaptionHealthForSession(session) {
		if (session.mode !== "transcribe") {
			this.#refreshSpeechReadiness(session);
			return;
		}
		await this.#refreshBrowserHealthForChromeSession(session);
	}
	async #refreshBrowserHealthForChromeSession(session) {
		if (!isManagedChromeBrowserSession(session)) {
			this.#refreshSpeechReadiness(session);
			return;
		}
		if (session.mode === "realtime" && evaluateSpeechReadiness(session).ready) {
			this.#refreshSpeechReadiness(session);
			return;
		}
		try {
			const result = session.transport === "chrome-node" ? await recoverCurrentMeetTabOnNode({
				runtime: this.params.runtime,
				config: this.params.config,
				mode: session.mode,
				url: session.url
			}) : await recoverCurrentMeetTab({
				config: this.params.config,
				mode: session.mode,
				url: session.url
			});
			if (result.found && result.browser && session.chrome) {
				session.chrome.health = {
					...session.chrome.health,
					...result.browser
				};
				session.updatedAt = nowIso();
			}
		} catch (error) {
			this.params.logger.debug?.(`[google-meet] browser readiness refresh ignored: ${formatErrorMessage(error)}`);
		}
		this.#refreshSpeechReadiness(session);
	}
	#refreshSpeechReadiness(session) {
		const readiness = evaluateSpeechReadiness(session);
		if (session.chrome) session.chrome.health = {
			...session.chrome.health,
			speechReady: readiness.ready,
			speechBlockedReason: readiness.reason,
			speechBlockedMessage: readiness.message
		};
		return readiness;
	}
	#refreshHealth(sessionId) {
		const ids = sessionId ? [sessionId] : [...this.#sessionHealth.keys()];
		for (const id of ids) {
			const session = this.#sessions.get(id);
			const getHealth = this.#sessionHealth.get(id);
			if (!session?.chrome || !getHealth) continue;
			session.chrome.health = {
				...session.chrome.health,
				...getHealth()
			};
			this.#refreshSpeechReadiness(session);
		}
	}
};
//#endregion
//#region extensions/google-meet/index.ts
const googleMeetConfigSchema = {
	parse(value) {
		return resolveGoogleMeetConfig(value);
	},
	uiHints: {
		"defaults.meeting": {
			label: "Default Meeting",
			help: "Meet URL, meeting code, or spaces/{id} used when CLI commands omit a meeting."
		},
		"preview.enrollmentAcknowledged": {
			label: "Preview Acknowledged",
			help: "Confirms you understand the Google Meet Media API is still Developer Preview.",
			advanced: true
		},
		defaultTransport: {
			label: "Default Transport",
			help: "Chrome uses a signed-in browser profile. Chrome-node runs Chrome on a paired node. Twilio uses Meet dial-in numbers."
		},
		defaultMode: {
			label: "Default Mode",
			help: "Realtime starts the duplex voice model loop. Transcribe joins/observes without the realtime talk-back bridge."
		},
		"chrome.audioBackend": {
			label: "Chrome Audio Backend",
			help: "BlackHole 2ch is required for local duplex audio routing."
		},
		"chrome.launch": { label: "Launch Chrome" },
		"chrome.browserProfile": {
			label: "Chrome Profile",
			advanced: true
		},
		"chrome.guestName": {
			label: "Guest Name",
			help: "Used when Chrome lands on the signed-out Meet guest-name screen."
		},
		"chrome.reuseExistingTab": {
			label: "Reuse Existing Meet Tab",
			help: "Avoids opening duplicate tabs for the same Meet URL."
		},
		"chrome.autoJoin": {
			label: "Auto Join Guest Screen",
			help: "Best-effort guest-name fill and Join Now click through OpenClaw browser automation."
		},
		"chrome.waitForInCallMs": {
			label: "Wait For In-Call (ms)",
			help: "Waits for Chrome to report that the Meet tab is in-call before the realtime intro speaks.",
			advanced: true
		},
		"chrome.audioFormat": {
			label: "Audio Format",
			help: "Command-pair audio format. PCM16 24 kHz is the default Chrome/Meet path; G.711 mu-law 8 kHz remains available for legacy command pairs.",
			advanced: true
		},
		"chrome.audioInputCommand": {
			label: "Audio Input Command",
			help: "Command that writes meeting audio to stdout in chrome.audioFormat.",
			advanced: true
		},
		"chrome.audioOutputCommand": {
			label: "Audio Output Command",
			help: "Command that reads assistant audio from stdin in chrome.audioFormat.",
			advanced: true
		},
		"chrome.bargeInInputCommand": {
			label: "Barge-In Input Command",
			help: "Optional Gateway-hosted microphone command that writes signed 16-bit little-endian mono PCM for human interruption detection while assistant playback is active.",
			advanced: true
		},
		"chrome.bargeInRmsThreshold": {
			label: "Barge-In RMS Threshold",
			help: "RMS level on chrome.bargeInInputCommand that counts as a human interruption.",
			advanced: true
		},
		"chrome.bargeInPeakThreshold": {
			label: "Barge-In Peak Threshold",
			help: "Peak level on chrome.bargeInInputCommand that counts as a human interruption.",
			advanced: true
		},
		"chrome.bargeInCooldownMs": {
			label: "Barge-In Cooldown (ms)",
			help: "Minimum delay between repeated barge-in clears.",
			advanced: true
		},
		"chrome.audioBridgeCommand": {
			label: "Audio Bridge Command",
			advanced: true
		},
		"chrome.audioBridgeHealthCommand": {
			label: "Audio Bridge Health Command",
			advanced: true
		},
		"chromeNode.node": {
			label: "Chrome Node",
			help: "Node id/name/IP that owns Chrome, BlackHole, and SoX for chrome-node transport.",
			advanced: true
		},
		"twilio.defaultDialInNumber": {
			label: "Default Dial-In Number",
			placeholder: "+15551234567"
		},
		"twilio.defaultPin": {
			label: "Default PIN",
			advanced: true
		},
		"twilio.defaultDtmfSequence": {
			label: "Default DTMF Sequence",
			advanced: true
		},
		"voiceCall.enabled": { label: "Delegate To Voice Call" },
		"voiceCall.gatewayUrl": {
			label: "Voice Call Gateway URL",
			advanced: true
		},
		"voiceCall.token": {
			label: "Voice Call Gateway Token",
			sensitive: true,
			advanced: true
		},
		"voiceCall.requestTimeoutMs": {
			label: "Voice Call Request Timeout (ms)",
			advanced: true
		},
		"voiceCall.dtmfDelayMs": {
			label: "Legacy DTMF Delay (ms)",
			help: "Compatibility setting from the old post-connect DTMF flow. Twilio Meet joins now play DTMF before realtime connect.",
			advanced: true
		},
		"voiceCall.postDtmfSpeechDelayMs": {
			label: "Legacy Post-DTMF Speech Delay (ms)",
			help: "Compatibility setting from the old delayed-speech flow. Twilio Meet joins now carry the intro as the initial Voice Call message.",
			advanced: true
		},
		"voiceCall.introMessage": {
			label: "Voice Call Intro Message",
			advanced: true
		},
		"realtime.provider": {
			label: "Realtime Provider",
			help: "Defaults to OpenAI; uses OPENAI_API_KEY when no provider config is set."
		},
		"realtime.model": {
			label: "Realtime Model",
			advanced: true
		},
		"realtime.instructions": {
			label: "Realtime Instructions",
			advanced: true
		},
		"realtime.introMessage": {
			label: "Realtime Intro Message",
			help: "Spoken once when the realtime bridge is ready. Set to an empty string to join silently."
		},
		"realtime.agentId": {
			label: "Realtime Consult Agent",
			help: "OpenClaw agent id used by openclaw_agent_consult. Defaults to \"main\".",
			advanced: true
		},
		"realtime.toolPolicy": {
			label: "Realtime Tool Policy",
			help: "Safe read-only tools are available by default; owner requests can unlock broader tools.",
			advanced: true
		},
		"oauth.clientId": { label: "OAuth Client ID" },
		"oauth.clientSecret": {
			label: "OAuth Client Secret",
			sensitive: true
		},
		"oauth.refreshToken": {
			label: "OAuth Refresh Token",
			sensitive: true
		},
		"oauth.accessToken": {
			label: "Cached Access Token",
			sensitive: true,
			advanced: true
		},
		"oauth.expiresAt": {
			label: "Cached Access Token Expiry",
			help: "Unix epoch milliseconds used only for the cached access-token fast path.",
			advanced: true
		}
	}
};
const GoogleMeetToolSchema = Type.Object({
	action: Type.String({
		enum: [
			"join",
			"create",
			"status",
			"setup_status",
			"resolve_space",
			"preflight",
			"latest",
			"calendar_events",
			"artifacts",
			"attendance",
			"export",
			"recover_current_tab",
			"leave",
			"end_active_conference",
			"speak",
			"test_speech",
			"test_listen"
		],
		description: "Google Meet action to run. create creates and joins by default; pass join=false to only mint a URL. After a timeout or unclear browser state, call recover_current_tab before retrying join."
	}),
	join: Type.Optional(Type.Boolean({ description: "For action=create, set false to create the URL without joining." })),
	accessType: Type.Optional(Type.String({
		enum: [
			"OPEN",
			"TRUSTED",
			"RESTRICTED"
		],
		description: "For action=create with Google Meet OAuth, configure who can join without knocking."
	})),
	entryPointAccess: Type.Optional(Type.String({
		enum: ["ALL", "CREATOR_APP_ONLY"],
		description: "For action=create with Google Meet OAuth, configure allowed join entry points."
	})),
	url: Type.Optional(Type.String({ description: "Explicit https://meet.google.com/... URL" })),
	transport: Type.Optional(Type.String({
		enum: [
			"chrome",
			"chrome-node",
			"twilio"
		],
		description: "Join transport"
	})),
	mode: Type.Optional(Type.String({
		enum: ["realtime", "transcribe"],
		description: "Join mode. realtime starts live listen/talk-back through the realtime voice model; transcribe joins without the realtime talk-back bridge."
	})),
	dialInNumber: Type.Optional(Type.String({ description: "Meet dial-in phone number for Twilio. Required for Twilio unless twilio.defaultDialInNumber is configured; Meet URLs cannot be dialed directly." })),
	pin: Type.Optional(Type.String({ description: "Meet phone PIN for Twilio; # is appended if omitted" })),
	dtmfSequence: Type.Optional(Type.String({ description: "Explicit DTMF sequence for Twilio" })),
	sessionId: Type.Optional(Type.String({ description: "Meet session ID" })),
	message: Type.Optional(Type.String({ description: "Realtime instructions to speak now" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Probe timeout in milliseconds" })),
	meeting: Type.Optional(Type.String({ description: "Meet URL, meeting code, or spaces/{id}" })),
	today: Type.Optional(Type.Boolean({ description: "For latest, artifacts, or attendance, find a Meet link on today's calendar." })),
	event: Type.Optional(Type.String({ description: "For latest, artifacts, or attendance, find a matching Calendar event." })),
	calendarId: Type.Optional(Type.String({ description: "Calendar id for today/event lookup" })),
	conferenceRecord: Type.Optional(Type.String({ description: "Meet conferenceRecords/{id} resource name or id" })),
	pageSize: Type.Optional(Type.Number({ description: "Meet API page size for list actions" })),
	includeTranscriptEntries: Type.Optional(Type.Boolean({ description: "For artifacts, include structured transcript entries" })),
	includeDocumentBodies: Type.Optional(Type.Boolean({ description: "For artifacts/export, export linked transcript and smart-note Google Docs text through Drive." })),
	outputDir: Type.Optional(Type.String({ description: "For export, output directory" })),
	zip: Type.Optional(Type.Boolean({ description: "For export, also write a .zip archive" })),
	dryRun: Type.Optional(Type.Boolean({ description: "For export, return the manifest without writing files." })),
	includeAllConferenceRecords: Type.Optional(Type.Boolean({ description: "For artifacts, attendance, or export with meeting input, fetch all conference records instead of only the latest." })),
	mergeDuplicateParticipants: Type.Optional(Type.Boolean({ description: "For attendance, merge duplicate participant resources." })),
	lateAfterMinutes: Type.Optional(Type.Number({ description: "For attendance, mark participants late after this many minutes." })),
	earlyBeforeMinutes: Type.Optional(Type.Number({ description: "For attendance, mark early leavers before this many minutes." })),
	accessToken: Type.Optional(Type.String({ description: "Access token override" })),
	refreshToken: Type.Optional(Type.String({ description: "Refresh token override" })),
	clientId: Type.Optional(Type.String({ description: "OAuth client id override" })),
	clientSecret: Type.Optional(Type.String({ description: "OAuth client secret override" })),
	expiresAt: Type.Optional(Type.Number({ description: "Cached access token expiry ms" }))
});
function asParamRecord(params) {
	return params && typeof params === "object" && !Array.isArray(params) ? params : {};
}
function json(payload) {
	return {
		content: [{
			type: "text",
			text: JSON.stringify(payload, null, 2)
		}],
		details: payload
	};
}
function normalizeTransport(value) {
	return value === "chrome" || value === "chrome-node" || value === "twilio" ? value : void 0;
}
function normalizeMode(value) {
	return value === "realtime" || value === "transcribe" ? value : void 0;
}
function resolveMeetingInput(config, value) {
	const meeting = normalizeOptionalString$1(value) ?? config.defaults.meeting;
	if (!meeting) throw new Error("Meeting input is required");
	return meeting;
}
function resolveOptionalPositiveInteger(value) {
	if (value === void 0) return;
	const parsed = typeof value === "number" ? value : Number(normalizeOptionalString$1(value));
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("Expected pageSize to be a positive integer");
	return parsed;
}
function shouldJoinCreatedMeet(raw) {
	return raw.join !== false && raw.join !== "false";
}
const googleMeetToolDeps = {
	callGatewayFromCli,
	platform: () => process.platform
};
const __testing = {
	setCallGatewayFromCliForTests(next) {
		googleMeetToolDeps.callGatewayFromCli = next ?? callGatewayFromCli;
	},
	setPlatformForTests(next) {
		googleMeetToolDeps.platform = next ?? (() => process.platform);
	},
	isGoogleMeetAgentToolActionUnsupportedOnHost
};
function googleMeetGatewayMethodForToolAction(action) {
	switch (action) {
		case "recover_current_tab": return "googlemeet.recoverCurrentTab";
		case "setup_status": return "googlemeet.setup";
		case "test_speech": return "googlemeet.testSpeech";
		case "test_listen": return "googlemeet.testListen";
		case "end_active_conference": return "googlemeet.endActiveConference";
		default: return `googlemeet.${action}`;
	}
}
function isGoogleMeetAgentToolActionUnsupportedOnHost(params) {
	if ((params.platform ?? googleMeetToolDeps.platform()) === "darwin") return false;
	const action = params.raw.action;
	if (action !== "join" && action !== "test_speech" && !(action === "create" && shouldJoinCreatedMeet(params.raw))) return false;
	const transport = normalizeTransport(params.raw.transport) ?? params.config.defaultTransport;
	const mode = action === "test_speech" ? "realtime" : normalizeMode(params.raw.mode) ?? params.config.defaultMode;
	return transport === "chrome" && mode === "realtime";
}
function assertGoogleMeetAgentToolActionSupported(params) {
	if (!isGoogleMeetAgentToolActionUnsupportedOnHost(params)) return;
	throw new Error("Google Meet local Chrome realtime audio is macOS-only. On this host, use mode: transcribe, transport: twilio, or transport: chrome-node backed by a macOS node.");
}
function resolveGoogleMeetToolGatewayTimeoutMs(config) {
	return Math.max(6e4, config.chrome.joinTimeoutMs + 3e4, config.voiceCall.requestTimeoutMs + 1e4);
}
function readGatewayErrorDetails(err) {
	if (!err || typeof err !== "object" || !("details" in err)) return;
	return err.details;
}
async function callGoogleMeetGatewayFromTool(params) {
	try {
		return await googleMeetToolDeps.callGatewayFromCli(googleMeetGatewayMethodForToolAction(params.action), {
			json: true,
			timeout: String(resolveGoogleMeetToolGatewayTimeoutMs(params.config))
		}, params.raw, { progress: false });
	} catch (err) {
		const details = readGatewayErrorDetails(err);
		if (details && typeof details === "object") return details;
		throw err;
	}
}
async function createMeetFromParams(params) {
	return (await import("../../create-B-IawHj7.js")).createMeetFromParams(params);
}
async function createAndJoinMeetFromParams(params) {
	return (await import("../../create-B-IawHj7.js")).createAndJoinMeetFromParams(params);
}
async function resolveGoogleMeetTokenFromParams(config, raw) {
	const { resolveGoogleMeetAccessToken } = await import("../../oauth-B2jCnxNi.js");
	return resolveGoogleMeetAccessToken({
		clientId: normalizeOptionalString$1(raw.clientId) ?? config.oauth.clientId,
		clientSecret: normalizeOptionalString$1(raw.clientSecret) ?? config.oauth.clientSecret,
		refreshToken: normalizeOptionalString$1(raw.refreshToken) ?? config.oauth.refreshToken,
		accessToken: normalizeOptionalString$1(raw.accessToken) ?? config.oauth.accessToken,
		expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : config.oauth.expiresAt
	});
}
function wantsCalendarLookup(raw) {
	return raw.today === true || Boolean(normalizeOptionalString$1(raw.event));
}
async function resolveMeetingFromParams(params) {
	if (wantsCalendarLookup(params.raw)) {
		const window = params.raw.today === true ? buildGoogleMeetCalendarDayWindow() : {};
		const calendarEvent = await findGoogleMeetCalendarEvent({
			accessToken: params.accessToken,
			calendarId: normalizeOptionalString$1(params.raw.calendarId),
			eventQuery: normalizeOptionalString$1(params.raw.event),
			...window
		});
		return {
			meeting: calendarEvent.meetingUri,
			calendarEvent
		};
	}
	return { meeting: resolveMeetingInput(params.config, params.raw.meeting) };
}
async function resolveSpaceFromParams(config, raw) {
	const token = await resolveGoogleMeetTokenFromParams(config, raw);
	const { meeting, calendarEvent } = await resolveMeetingFromParams({
		config,
		raw,
		accessToken: token.accessToken
	});
	return {
		meeting,
		token,
		space: await fetchGoogleMeetSpace({
			accessToken: token.accessToken,
			meeting
		}),
		calendarEvent
	};
}
async function resolveArtifactQueryFromParams(config, raw) {
	const meeting = normalizeOptionalString$1(raw.meeting) ?? config.defaults.meeting;
	const conferenceRecord = normalizeOptionalString$1(raw.conferenceRecord);
	const token = await resolveGoogleMeetTokenFromParams(config, raw);
	const resolvedMeeting = conferenceRecord ? { meeting } : wantsCalendarLookup(raw) ? await resolveMeetingFromParams({
		config,
		raw,
		accessToken: token.accessToken
	}) : { meeting };
	if (!resolvedMeeting.meeting && !conferenceRecord) throw new Error("Meeting input, calendar lookup, or conferenceRecord required");
	return {
		token,
		meeting: resolvedMeeting.meeting,
		calendarEvent: resolvedMeeting.calendarEvent,
		conferenceRecord,
		pageSize: resolveOptionalPositiveInteger(raw.pageSize),
		includeTranscriptEntries: raw.includeTranscriptEntries !== false,
		includeDocumentBodies: raw.includeDocumentBodies === true,
		allConferenceRecords: raw.includeAllConferenceRecords === true,
		mergeDuplicateParticipants: raw.mergeDuplicateParticipants !== false,
		lateAfterMinutes: resolveOptionalPositiveInteger(raw.lateAfterMinutes),
		earlyBeforeMinutes: resolveOptionalPositiveInteger(raw.earlyBeforeMinutes)
	};
}
async function exportGoogleMeetBundleFromParams(config, raw) {
	const resolved = await resolveArtifactQueryFromParams(config, raw);
	const [artifacts, attendance] = await Promise.all([fetchGoogleMeetArtifacts({
		accessToken: resolved.token.accessToken,
		meeting: resolved.meeting,
		conferenceRecord: resolved.conferenceRecord,
		pageSize: resolved.pageSize,
		includeTranscriptEntries: resolved.includeTranscriptEntries,
		includeDocumentBodies: resolved.includeDocumentBodies,
		allConferenceRecords: resolved.allConferenceRecords
	}), fetchGoogleMeetAttendance({
		accessToken: resolved.token.accessToken,
		meeting: resolved.meeting,
		conferenceRecord: resolved.conferenceRecord,
		pageSize: resolved.pageSize,
		allConferenceRecords: resolved.allConferenceRecords,
		mergeDuplicateParticipants: resolved.mergeDuplicateParticipants,
		lateAfterMinutes: resolved.lateAfterMinutes,
		earlyBeforeMinutes: resolved.earlyBeforeMinutes
	})]);
	const { buildGoogleMeetExportManifest, googleMeetExportFileNames, writeMeetExportBundle } = await import("../../cli-C9nnQD0x.js");
	const calendarId = normalizeOptionalString$1(raw.calendarId);
	const request = {
		...resolved.meeting ? { meeting: resolved.meeting } : {},
		...resolved.conferenceRecord ? { conferenceRecord: resolved.conferenceRecord } : {},
		...resolved.calendarEvent?.event.id ? { calendarEventId: resolved.calendarEvent.event.id } : {},
		...resolved.calendarEvent?.event.summary ? { calendarEventSummary: resolved.calendarEvent.event.summary } : {},
		...calendarId ? { calendarId } : {},
		...resolved.pageSize !== void 0 ? { pageSize: resolved.pageSize } : {},
		includeTranscriptEntries: resolved.includeTranscriptEntries,
		includeDocumentBodies: resolved.includeDocumentBodies,
		allConferenceRecords: resolved.allConferenceRecords,
		mergeDuplicateParticipants: resolved.mergeDuplicateParticipants,
		...resolved.lateAfterMinutes !== void 0 ? { lateAfterMinutes: resolved.lateAfterMinutes } : {},
		...resolved.earlyBeforeMinutes !== void 0 ? { earlyBeforeMinutes: resolved.earlyBeforeMinutes } : {}
	};
	const tokenSource = resolved.token.refreshed ? "refresh-token" : "cached-access-token";
	if (raw.dryRun === true) return {
		dryRun: true,
		manifest: buildGoogleMeetExportManifest({
			artifacts,
			attendance,
			files: googleMeetExportFileNames(),
			request,
			tokenSource,
			...resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}
		}),
		...resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {},
		tokenSource
	};
	const outputDir = normalizeOptionalString$1(raw.outputDir) ?? normalizeOptionalString$1(raw.output);
	return {
		...await writeMeetExportBundle({
			...outputDir ? { outputDir } : {},
			artifacts,
			attendance,
			zip: raw.zip === true,
			request,
			tokenSource,
			...resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}
		}),
		...resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {},
		tokenSource
	};
}
var google_meet_default = definePluginEntry({
	id: "google-meet",
	name: "Google Meet",
	description: "Join Google Meet calls through Chrome or Twilio transports",
	configSchema: googleMeetConfigSchema,
	register(api) {
		const config = googleMeetConfigSchema.parse(api.pluginConfig);
		let runtime = null;
		const ensureRuntime = async () => {
			if (!config.enabled) throw new Error("Google Meet plugin disabled in plugin config");
			if (!runtime) runtime = new GoogleMeetRuntime({
				config,
				fullConfig: api.config,
				runtime: api.runtime,
				logger: api.logger
			});
			return runtime;
		};
		const formatGatewayError = (err) => isGoogleMeetBrowserManualActionError(err) ? err.payload : { error: formatErrorMessage(err) };
		const sendError = (respond, err, code = ErrorCodes.UNAVAILABLE) => {
			const payload = formatGatewayError(err);
			respond(false, payload, errorShape(code, typeof payload.error === "string" ? payload.error : "Google Meet request failed", { details: payload }));
		};
		api.registerGatewayMethod("googlemeet.join", async ({ params, respond }) => {
			try {
				respond(true, await (await ensureRuntime()).join({
					url: resolveMeetingInput(config, params?.url),
					transport: normalizeTransport(params?.transport),
					mode: normalizeMode(params?.mode),
					dialInNumber: normalizeOptionalString$1(params?.dialInNumber),
					pin: normalizeOptionalString$1(params?.pin),
					dtmfSequence: normalizeOptionalString$1(params?.dtmfSequence),
					message: normalizeOptionalString$1(params?.message)
				}));
			} catch (err) {
				sendError(respond, err);
			}
		});
		api.registerGatewayMethod("googlemeet.create", async ({ params, respond }) => {
			try {
				const raw = asParamRecord(params);
				respond(true, shouldJoinCreatedMeet(raw) ? await createAndJoinMeetFromParams({
					config,
					runtime: api.runtime,
					raw,
					ensureRuntime
				}) : await createMeetFromParams({
					config,
					runtime: api.runtime,
					raw
				}));
			} catch (err) {
				sendError(respond, err);
			}
		});
		api.registerGatewayMethod("googlemeet.status", async ({ params, respond }) => {
			try {
				respond(true, await (await ensureRuntime()).status(normalizeOptionalString$1(params?.sessionId)));
			} catch (err) {
				sendError(respond, err);
			}
		});
		api.registerGatewayMethod("googlemeet.recoverCurrentTab", async ({ params, respond }) => {
			try {
				respond(true, await (await ensureRuntime()).recoverCurrentTab({
					url: normalizeOptionalString$1(params?.url),
					transport: normalizeTransport(params?.transport)
				}));
			} catch (err) {
				sendError(respond, err);
			}
		});
		api.registerGatewayMethod("googlemeet.setup", async ({ params, respond }) => {
			try {
				respond(true, await (await ensureRuntime()).setupStatus({
					transport: normalizeTransport(params?.transport),
					mode: normalizeMode(params?.mode),
					dialInNumber: normalizeOptionalString$1(params?.dialInNumber)
				}));
			} catch (err) {
				sendError(respond, err);
			}
		});
		api.registerGatewayMethod("googlemeet.latest", async ({ params, respond }) => {
			try {
				const raw = asParamRecord(params);
				const token = await resolveGoogleMeetTokenFromParams(config, raw);
				const resolved = await resolveMeetingFromParams({
					config,
					raw,
					accessToken: token.accessToken
				});
				respond(true, {
					...await fetchLatestGoogleMeetConferenceRecord({
						accessToken: token.accessToken,
						meeting: resolved.meeting
					}),
					...resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}
				});
			} catch (err) {
				sendError(respond, err);
			}
		});
		api.registerGatewayMethod("googlemeet.calendarEvents", async ({ params, respond }) => {
			try {
				const raw = asParamRecord(params);
				const token = await resolveGoogleMeetTokenFromParams(config, raw);
				const window = raw.today === true ? buildGoogleMeetCalendarDayWindow() : {};
				respond(true, await listGoogleMeetCalendarEvents({
					accessToken: token.accessToken,
					calendarId: normalizeOptionalString$1(raw.calendarId),
					eventQuery: normalizeOptionalString$1(raw.event),
					...window
				}));
			} catch (err) {
				sendError(respond, err);
			}
		});
		api.registerGatewayMethod("googlemeet.artifacts", async ({ params, respond }) => {
			try {
				const resolved = await resolveArtifactQueryFromParams(config, asParamRecord(params));
				respond(true, await fetchGoogleMeetArtifacts({
					accessToken: resolved.token.accessToken,
					meeting: resolved.meeting,
					conferenceRecord: resolved.conferenceRecord,
					pageSize: resolved.pageSize,
					includeTranscriptEntries: resolved.includeTranscriptEntries,
					includeDocumentBodies: resolved.includeDocumentBodies,
					allConferenceRecords: resolved.allConferenceRecords
				}));
			} catch (err) {
				sendError(respond, err);
			}
		});
		api.registerGatewayMethod("googlemeet.attendance", async ({ params, respond }) => {
			try {
				const resolved = await resolveArtifactQueryFromParams(config, asParamRecord(params));
				respond(true, await fetchGoogleMeetAttendance({
					accessToken: resolved.token.accessToken,
					meeting: resolved.meeting,
					conferenceRecord: resolved.conferenceRecord,
					pageSize: resolved.pageSize,
					allConferenceRecords: resolved.allConferenceRecords,
					mergeDuplicateParticipants: resolved.mergeDuplicateParticipants,
					lateAfterMinutes: resolved.lateAfterMinutes,
					earlyBeforeMinutes: resolved.earlyBeforeMinutes
				}));
			} catch (err) {
				sendError(respond, err);
			}
		});
		api.registerGatewayMethod("googlemeet.export", async ({ params, respond }) => {
			try {
				respond(true, await exportGoogleMeetBundleFromParams(config, asParamRecord(params)));
			} catch (err) {
				sendError(respond, err);
			}
		});
		api.registerGatewayMethod("googlemeet.leave", async ({ params, respond }) => {
			try {
				const sessionId = normalizeOptionalString$1(params?.sessionId);
				if (!sessionId) {
					sendError(respond, /* @__PURE__ */ new Error("sessionId required"), ErrorCodes.INVALID_REQUEST);
					return;
				}
				respond(true, await (await ensureRuntime()).leave(sessionId));
			} catch (err) {
				sendError(respond, err);
			}
		});
		api.registerGatewayMethod("googlemeet.endActiveConference", async ({ params, respond }) => {
			try {
				const raw = asParamRecord(params);
				respond(true, await endGoogleMeetActiveConference({
					accessToken: (await resolveGoogleMeetTokenFromParams(config, raw)).accessToken,
					meeting: resolveMeetingInput(config, raw.meeting)
				}));
			} catch (err) {
				sendError(respond, err);
			}
		});
		api.registerGatewayMethod("googlemeet.speak", async ({ params, respond }) => {
			try {
				const sessionId = normalizeOptionalString$1(params?.sessionId);
				if (!sessionId) {
					sendError(respond, /* @__PURE__ */ new Error("sessionId required"), ErrorCodes.INVALID_REQUEST);
					return;
				}
				respond(true, await (await ensureRuntime()).speak(sessionId, normalizeOptionalString$1(params?.message)));
			} catch (err) {
				sendError(respond, err);
			}
		});
		api.registerGatewayMethod("googlemeet.testSpeech", async ({ params, respond }) => {
			try {
				respond(true, await (await ensureRuntime()).testSpeech({
					url: resolveMeetingInput(config, params?.url),
					transport: normalizeTransport(params?.transport),
					mode: normalizeMode(params?.mode),
					dialInNumber: normalizeOptionalString$1(params?.dialInNumber),
					pin: normalizeOptionalString$1(params?.pin),
					dtmfSequence: normalizeOptionalString$1(params?.dtmfSequence),
					message: normalizeOptionalString$1(params?.message)
				}));
			} catch (err) {
				sendError(respond, err);
			}
		});
		api.registerGatewayMethod("googlemeet.testListen", async ({ params, respond }) => {
			try {
				respond(true, await (await ensureRuntime()).testListen({
					url: resolveMeetingInput(config, params?.url),
					transport: normalizeTransport(params?.transport),
					mode: normalizeMode(params?.mode),
					timeoutMs: typeof params?.timeoutMs === "number" ? params.timeoutMs : void 0
				}));
			} catch (err) {
				sendError(respond, err);
			}
		});
		api.registerTool({
			name: "google_meet",
			label: "Google Meet",
			description: "Join and track Google Meet sessions through Chrome or Twilio. Call setup_status before join/create/test_listen/test_speech; if it reports a Chrome node offline, local audio missing, or missing Twilio dial plan, surface that blocker instead of retrying or switching transports. Twilio cannot dial a Meet URL directly: provide dialInNumber plus optional pin/dtmfSequence, or configure twilio.defaultDialInNumber. Offline nodes are diagnostics only, not usable candidates. If local Chrome realtime audio is unsupported on this OS, use mode=transcribe, transport=twilio, or a macOS chrome-node for realtime Chrome. If a Meet tab is already open after a timeout, call recover_current_tab before retrying join to report login, permission, or admission blockers without opening another tab.",
			parameters: GoogleMeetToolSchema,
			async execute(_toolCallId, params) {
				const raw = asParamRecord(params);
				try {
					assertGoogleMeetAgentToolActionSupported({
						config,
						raw
					});
					switch (raw.action) {
						case "join": return json(await callGoogleMeetGatewayFromTool({
							config,
							action: "join",
							raw
						}));
						case "create": return json(await callGoogleMeetGatewayFromTool({
							config,
							action: "create",
							raw
						}));
						case "test_speech": return json(await callGoogleMeetGatewayFromTool({
							config,
							action: "test_speech",
							raw
						}));
						case "test_listen": return json(await callGoogleMeetGatewayFromTool({
							config,
							action: "test_listen",
							raw
						}));
						case "status": return json(await callGoogleMeetGatewayFromTool({
							config,
							action: "status",
							raw
						}));
						case "recover_current_tab": return json(await callGoogleMeetGatewayFromTool({
							config,
							action: "recover_current_tab",
							raw
						}));
						case "setup_status": return json(await callGoogleMeetGatewayFromTool({
							config,
							action: "setup_status",
							raw
						}));
						case "resolve_space": {
							const { token: _token, ...result } = await resolveSpaceFromParams(config, raw);
							return json(result);
						}
						case "preflight": {
							const { meeting, token, space } = await resolveSpaceFromParams(config, raw);
							return json(buildGoogleMeetPreflightReport({
								input: meeting,
								space,
								previewAcknowledged: config.preview.enrollmentAcknowledged,
								tokenSource: token.refreshed ? "refresh-token" : "cached-access-token"
							}));
						}
						case "latest": {
							const token = await resolveGoogleMeetTokenFromParams(config, raw);
							const resolved = await resolveMeetingFromParams({
								config,
								raw,
								accessToken: token.accessToken
							});
							return json({
								...await fetchLatestGoogleMeetConferenceRecord({
									accessToken: token.accessToken,
									meeting: resolved.meeting
								}),
								...resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}
							});
						}
						case "calendar_events": {
							const token = await resolveGoogleMeetTokenFromParams(config, raw);
							const window = raw.today === true ? buildGoogleMeetCalendarDayWindow() : {};
							return json(await listGoogleMeetCalendarEvents({
								accessToken: token.accessToken,
								calendarId: normalizeOptionalString$1(raw.calendarId),
								eventQuery: normalizeOptionalString$1(raw.event),
								...window
							}));
						}
						case "artifacts": {
							const resolved = await resolveArtifactQueryFromParams(config, raw);
							return json(await fetchGoogleMeetArtifacts({
								accessToken: resolved.token.accessToken,
								meeting: resolved.meeting,
								conferenceRecord: resolved.conferenceRecord,
								pageSize: resolved.pageSize,
								includeTranscriptEntries: resolved.includeTranscriptEntries,
								includeDocumentBodies: resolved.includeDocumentBodies,
								allConferenceRecords: resolved.allConferenceRecords
							}));
						}
						case "attendance": {
							const resolved = await resolveArtifactQueryFromParams(config, raw);
							return json(await fetchGoogleMeetAttendance({
								accessToken: resolved.token.accessToken,
								meeting: resolved.meeting,
								conferenceRecord: resolved.conferenceRecord,
								pageSize: resolved.pageSize,
								allConferenceRecords: resolved.allConferenceRecords,
								mergeDuplicateParticipants: resolved.mergeDuplicateParticipants,
								lateAfterMinutes: resolved.lateAfterMinutes,
								earlyBeforeMinutes: resolved.earlyBeforeMinutes
							}));
						}
						case "export": return json(await exportGoogleMeetBundleFromParams(config, raw));
						case "leave":
							if (!normalizeOptionalString$1(raw.sessionId)) throw new Error("sessionId required");
							return json(await callGoogleMeetGatewayFromTool({
								config,
								action: "leave",
								raw
							}));
						case "end_active_conference": return json(await callGoogleMeetGatewayFromTool({
							config,
							action: "end_active_conference",
							raw
						}));
						case "speak":
							if (!normalizeOptionalString$1(raw.sessionId)) throw new Error("sessionId required");
							return json(await callGoogleMeetGatewayFromTool({
								config,
								action: "speak",
								raw
							}));
						default: throw new Error("unknown google_meet action");
					}
				} catch (err) {
					return json(formatGatewayError(err));
				}
			}
		});
		api.registerNodeHostCommand({
			command: "googlemeet.chrome",
			cap: "google-meet",
			handle: handleGoogleMeetNodeHostCommand
		});
		api.registerCli(async ({ program }) => {
			const { registerGoogleMeetCli } = await import("../../cli-C9nnQD0x.js");
			registerGoogleMeetCli({
				program,
				config,
				ensureRuntime
			});
		}, {
			commands: ["googlemeet"],
			descriptors: [{
				name: "googlemeet",
				description: "Join and manage Google Meet calls",
				hasSubcommands: true
			}]
		});
	}
});
//#endregion
export { __testing, google_meet_default as default };
