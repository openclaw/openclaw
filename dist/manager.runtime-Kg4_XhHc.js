import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { b as escapeRegExp } from "./utils-sBTEdeml.js";
import { a as resolveAgentDir } from "./agent-scope-config-CMp71_27.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import { a as shouldLogVerbose, r as logVerbose } from "./globals-YU5FjfZK.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { t as tempWorkspace } from "./private-temp-workspace-DgditT3G.js";
import { i as stripInlineDirectiveTagsForDisplay } from "./directive-tags-CClLEtM7.js";
import { i as resolveAgentRoute } from "./resolve-route-C8IahAyG.js";
import "./temp-path-DllZid8c.js";
import { _ as resolveTtsPrefsPath, g as resolveTtsConfig, o as getTtsProvider } from "./tts-runtime-B3-lBCQj.js";
import { n as parseTtsDirectives } from "./directives-DiYOXJC0.js";
import "./runtime-env-BtvWnLRh.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./routing-79DRZvfm.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./text-chunking-C154U6-i.js";
import "./agent-runtime-Lc7H-PlR.js";
import { n as agentCommandFromIngress } from "./agent-command-QBBzz2Au.js";
import { n as resolveRealtimeBootstrapContextInstructions } from "./realtime-bootstrap-context-CW-g5pqa.js";
import { A as REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ, _ as resolveRealtimeVoiceAgentConsultToolPolicy, d as buildRealtimeVoiceAgentConsultPolicyInstructions, n as resolveConfiguredRealtimeVoiceProvider, p as buildRealtimeVoiceAgentConsultWorkingResponse, t as createRealtimeVoiceBridgeSession, u as buildRealtimeVoiceAgentConsultChatMessage, v as resolveRealtimeVoiceAgentConsultTools, y as resolveRealtimeVoiceAgentConsultToolsAllow } from "./session-runtime-CCTSwqCz.js";
import { i as resamplePcm, p as createRealtimeVoiceAgentTalkbackQueue } from "./realtime-voice-D-uczs8E.js";
import "./speech-DNHVYL_R.js";
import "./text-utility-runtime-CaGXarh9.js";
import { c as resolveDiscordAccountAllowFrom } from "./accounts-DIRzXd2H.js";
import { t as parseDiscordTarget } from "./target-parsing-D1FhMbX6.js";
import { Ct as getGuildVoiceState, It as ChannelType, l as VoiceStateUpdateListener, o as ReadyListener, s as ResumedListener } from "./discord-Cn5UmvYW.js";
import { n as formatDiscordUserTag } from "./format-DZW075F7.js";
import { a as normalizeDiscordSlug, m as resolveDiscordOwnerAccess } from "./allow-list-COYqm2Y0.js";
import { t as formatMention } from "./mentions-C321Y4sH.js";
import { t as getDiscordRuntime } from "./runtime-B_MWZ4rH.js";
import { t as buildDiscordGroupSystemPrompt } from "./inbound-context-DXIN2Bms.js";
import { n as resolveDiscordVoiceEnabled, t as authorizeDiscordVoiceIngress } from "./access-976OjPFd.js";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs/promises";
import { PassThrough, Readable } from "node:stream";
//#region extensions/discord/src/voice/audio.ts
const require = createRequire(import.meta.url);
const SAMPLE_RATE = 48e3;
const CHANNELS = 2;
const BIT_DEPTH = 16;
let warnedOpusMissing = false;
let cachedOpusDecoderFactory = "unresolved";
function buildWavBuffer(pcm) {
	const blockAlign = CHANNELS * BIT_DEPTH / 8;
	const byteRate = SAMPLE_RATE * blockAlign;
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(CHANNELS, 22);
	header.writeUInt32LE(SAMPLE_RATE, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(blockAlign, 32);
	header.writeUInt16LE(BIT_DEPTH, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}
function resolveOpusDecoderFactory(params) {
	const nativeFactory = {
		name: "@discordjs/opus",
		load: () => {
			return new (require("@discordjs/opus")).OpusEncoder(SAMPLE_RATE, CHANNELS);
		}
	};
	const opusscriptFactory = {
		name: "opusscript",
		load: () => {
			const OpusScript = require("opusscript");
			return new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
		}
	};
	const factories = resolveOpusDecoderPreference() === "native" ? [nativeFactory, opusscriptFactory] : [opusscriptFactory, nativeFactory];
	const failures = [];
	for (const factory of factories) try {
		factory.load();
		return factory;
	} catch (err) {
		failures.push(`${factory.name}: ${formatErrorMessage(err)}`);
	}
	if (!warnedOpusMissing) {
		warnedOpusMissing = true;
		params.onWarn(`discord voice: no usable opus decoder available (${failures.join("; ")}); cannot decode voice audio`);
	}
	return null;
}
function resolveOpusDecoderPreference(value = process.env.OPENCLAW_DISCORD_OPUS_DECODER) {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "native" || normalized === "@discordjs/opus") return "native";
	return "opusscript";
}
function getOrCreateOpusDecoderFactory(params) {
	if (cachedOpusDecoderFactory !== "unresolved") return cachedOpusDecoderFactory;
	cachedOpusDecoderFactory = resolveOpusDecoderFactory(params);
	return cachedOpusDecoderFactory;
}
function createOpusDecoder(params) {
	const factory = getOrCreateOpusDecoderFactory(params);
	if (!factory) return null;
	return {
		decoder: factory.load(),
		name: factory.name
	};
}
async function decodeOpusStream(stream, params) {
	const selected = createOpusDecoder({ onWarn: params.onWarn });
	if (!selected) return Buffer.alloc(0);
	params.onVerbose(`opus decoder: ${selected.name}`);
	const chunks = [];
	try {
		for await (const chunk of stream) {
			if (!chunk || !(chunk instanceof Buffer) || chunk.length === 0) continue;
			const decoded = selected.decoder.decode(chunk);
			if (decoded && decoded.length > 0) chunks.push(Buffer.from(decoded));
		}
	} catch (err) {
		if (shouldLogVerbose()) logVerbose(`discord voice: opus decode failed: ${formatErrorMessage(err)}`);
	}
	return chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
}
async function decodeOpusStreamChunks(stream, params) {
	const selected = createOpusDecoder({ onWarn: params.onWarn });
	if (!selected) return;
	params.onVerbose(`opus decoder: ${selected.name}`);
	try {
		for await (const chunk of stream) {
			if (!chunk || !(chunk instanceof Buffer) || chunk.length === 0) continue;
			const decoded = selected.decoder.decode(chunk);
			if (decoded && decoded.length > 0) params.onChunk(Buffer.from(decoded));
		}
	} catch (err) {
		if (shouldLogVerbose()) logVerbose(`discord voice: opus decode failed: ${formatErrorMessage(err)}`);
	}
}
function convertDiscordPcm48kStereoToRealtimePcm24kMono(pcm) {
	const frameCount = Math.floor(pcm.length / 4);
	if (frameCount === 0) return Buffer.alloc(0);
	const mono48k = Buffer.alloc(frameCount * 2);
	for (let frame = 0; frame < frameCount; frame += 1) {
		const offset = frame * 4;
		const left = pcm.readInt16LE(offset);
		const right = pcm.readInt16LE(offset + 2);
		mono48k.writeInt16LE(Math.round((left + right) / 2), frame * 2);
	}
	return resamplePcm(mono48k, SAMPLE_RATE, 24e3);
}
function convertRealtimePcm24kMonoToDiscordPcm48kStereo(pcm) {
	const mono48k = resamplePcm(pcm, 24e3, SAMPLE_RATE);
	const sampleCount = Math.floor(mono48k.length / 2);
	if (sampleCount === 0) return Buffer.alloc(0);
	const stereo = Buffer.alloc(sampleCount * 4);
	for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
		const sample = mono48k.readInt16LE(sampleIndex * 2);
		const offset = sampleIndex * 4;
		stereo.writeInt16LE(sample, offset);
		stereo.writeInt16LE(sample, offset + 2);
	}
	return stereo;
}
function estimateDurationSeconds(pcm) {
	const bytesPerSample = BIT_DEPTH / 8 * CHANNELS;
	return pcm.length / (bytesPerSample * SAMPLE_RATE);
}
async function writeVoiceWavFile(pcm) {
	const workspace = await tempWorkspace({
		rootDir: resolvePreferredOpenClawTmpDir(),
		prefix: "discord-voice-"
	});
	const wav = buildWavBuffer(pcm);
	const filePath = await workspace.write("segment.wav", wav);
	scheduleTempCleanup(workspace.dir);
	return {
		path: filePath,
		durationSeconds: estimateDurationSeconds(pcm)
	};
}
function scheduleTempCleanup(tempDir, delayMs = 1800 * 1e3) {
	setTimeout(() => {
		fs.rm(tempDir, {
			recursive: true,
			force: true
		}).catch((err) => {
			if (shouldLogVerbose()) logVerbose(`discord voice: temp cleanup failed for ${tempDir}: ${formatErrorMessage(err)}`);
		});
	}, delayMs).unref();
}
//#endregion
//#region extensions/discord/src/voice/capture-state.ts
function createVoiceCaptureState() {
	return {
		activeSpeakers: /* @__PURE__ */ new Set(),
		activeCaptureStreams: /* @__PURE__ */ new Map(),
		captureFinalizeTimers: /* @__PURE__ */ new Map(),
		captureGenerations: /* @__PURE__ */ new Map()
	};
}
function stopVoiceCaptureState(state) {
	for (const { timer } of state.captureFinalizeTimers.values()) clearTimeout(timer);
	state.captureFinalizeTimers.clear();
	for (const { stream } of state.activeCaptureStreams.values()) stream.destroy();
	state.activeCaptureStreams.clear();
	state.captureGenerations.clear();
	state.activeSpeakers.clear();
}
function getActiveVoiceCapture(state, userId) {
	return state.activeCaptureStreams.get(userId);
}
function isVoiceCaptureActive(state, userId) {
	return state.activeSpeakers.has(userId);
}
function clearVoiceCaptureFinalizeTimer(state, userId, generation) {
	const scheduled = state.captureFinalizeTimers.get(userId);
	if (!scheduled || generation !== void 0 && scheduled.generation !== generation) return false;
	clearTimeout(scheduled.timer);
	state.captureFinalizeTimers.delete(userId);
	return true;
}
function beginVoiceCapture(state, userId, stream) {
	const generation = (state.captureGenerations.get(userId) ?? 0) + 1;
	state.captureGenerations.set(userId, generation);
	state.activeSpeakers.add(userId);
	state.activeCaptureStreams.set(userId, {
		generation,
		stream
	});
	clearVoiceCaptureFinalizeTimer(state, userId, generation);
	return generation;
}
function finishVoiceCapture(state, userId, generation) {
	clearVoiceCaptureFinalizeTimer(state, userId, generation);
	if (state.activeCaptureStreams.get(userId)?.generation !== generation) return false;
	state.activeCaptureStreams.delete(userId);
	state.activeSpeakers.delete(userId);
	return true;
}
function scheduleVoiceCaptureFinalize(params) {
	const { state, userId, delayMs, onFinalize } = params;
	const capture = state.activeCaptureStreams.get(userId);
	if (!capture) return false;
	clearVoiceCaptureFinalizeTimer(state, userId, capture.generation);
	const timer = setTimeout(() => {
		const activeCapture = state.activeCaptureStreams.get(userId);
		if (!activeCapture || activeCapture.generation !== capture.generation) return;
		state.captureFinalizeTimers.delete(userId);
		state.activeCaptureStreams.delete(userId);
		state.activeSpeakers.delete(userId);
		onFinalize?.(activeCapture);
		activeCapture.stream.destroy();
	}, delayMs);
	state.captureFinalizeTimers.set(userId, {
		generation: capture.generation,
		timer
	});
	return true;
}
const logger$3 = createSubsystemLogger("discord/voice");
function summarizeAgentTurnPayloads(payloads) {
	let textPayloads = 0;
	let nonEmptyTextPayloads = 0;
	let reasoningPayloads = 0;
	let errorPayloads = 0;
	let mediaPayloads = 0;
	for (const payload of payloads) {
		if (!payload || typeof payload !== "object") continue;
		const record = payload;
		const text = record.text;
		if (typeof text === "string") {
			textPayloads += 1;
			if (text.trim()) nonEmptyTextPayloads += 1;
		}
		if (record.isReasoning === true) reasoningPayloads += 1;
		if (record.isError === true) errorPayloads += 1;
		if (typeof record.mediaUrl === "string" || Array.isArray(record.mediaUrls) && record.mediaUrls.length > 0) mediaPayloads += 1;
	}
	return `payloadCount=${payloads.length} textPayloads=${textPayloads} nonEmptyTextPayloads=${nonEmptyTextPayloads} reasoningPayloads=${reasoningPayloads} errorPayloads=${errorPayloads} mediaPayloads=${mediaPayloads}`;
}
async function resolveDiscordVoiceIngressContext(params) {
	const { entry, userId } = params;
	if (!entry.guildName) entry.guildName = await params.fetchGuildName(entry.guildId);
	const speaker = await params.speakerContext.resolveContext(entry.guildId, userId);
	const speakerIdentity = await params.speakerContext.resolveIdentity(entry.guildId, userId);
	const access = await authorizeDiscordVoiceIngress({
		cfg: params.cfg,
		discordConfig: params.discordConfig,
		guildName: entry.guildName,
		guildId: entry.guildId,
		channelId: entry.channelId,
		channelName: entry.channelName,
		channelSlug: entry.channelName ? normalizeDiscordSlug(entry.channelName) : "",
		channelLabel: formatMention({ channelId: entry.channelId }),
		memberRoleIds: speakerIdentity.memberRoleIds,
		ownerAllowFrom: params.ownerAllowFrom,
		sender: {
			id: speakerIdentity.id,
			name: speakerIdentity.name,
			tag: speakerIdentity.tag
		}
	});
	if (!access.ok) return null;
	return {
		extraSystemPrompt: buildDiscordGroupSystemPrompt(access.channelConfig),
		senderIsOwner: speaker.senderIsOwner,
		speakerLabel: speaker.label
	};
}
async function runDiscordVoiceAgentTurn(params) {
	const context = params.context ?? await resolveDiscordVoiceIngressContext({
		entry: params.entry,
		userId: params.userId,
		cfg: params.cfg,
		discordConfig: params.discordConfig,
		ownerAllowFrom: params.ownerAllowFrom,
		fetchGuildName: params.fetchGuildName,
		speakerContext: params.speakerContext
	});
	if (!context) return null;
	const voiceModel = normalizeOptionalString(params.discordConfig.voice?.model);
	const payloads = (await agentCommandFromIngress({
		message: params.message,
		sessionKey: params.entry.route.sessionKey,
		agentId: params.entry.route.agentId,
		messageChannel: "discord",
		messageProvider: "discord-voice",
		extraSystemPrompt: context.extraSystemPrompt,
		allowModelOverride: Boolean(voiceModel),
		model: voiceModel,
		toolsAllow: params.toolsAllow,
		deliver: false
	}, params.runtime)).payloads ?? [];
	const text = payloads.map((payload) => payload.text).filter((entry) => typeof entry === "string" && entry.trim()).join("\n").trim();
	if (!text) logger$3.info(`discord voice: agent turn produced no speakable payloads guild=${params.entry.guildId} channel=${params.entry.channelId} voiceSession=${params.entry.voiceSessionKey} supervisorSession=${params.entry.route.sessionKey} agent=${params.entry.route.agentId} user=${params.userId} ${summarizeAgentTurnPayloads(payloads)}`);
	return {
		context,
		text
	};
}
async function resolveDiscordVoiceRealtimeBootstrapContext(params) {
	const files = (params.discordConfig.voice?.realtime)?.bootstrapContextFiles;
	if (files?.length === 0) return;
	try {
		return await resolveRealtimeBootstrapContextInstructions({
			config: params.cfg,
			agentId: params.entry.route.agentId,
			sessionKey: params.entry.route.sessionKey,
			files,
			warn: (message) => logger$3.warn(`discord voice: realtime bootstrap context: ${message}`)
		});
	} catch (error) {
		logger$3.warn(`discord voice: realtime bootstrap context unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
}
//#endregion
//#region extensions/discord/src/voice/prompt.ts
const DISCORD_VOICE_SPOKEN_OUTPUT_CONTRACT = [
	"You are OpenClaw's Discord voice interface in a live voice channel.",
	"Discord voice reply requirements:",
	"- Return only the concise text that should be spoken aloud in the voice channel.",
	"- Treat the transcript as speech-to-text from a live conversation; repair obvious transcription artifacts and ignore repeated partial fragments caused by voice buffering.",
	"- If the transcript is garbled, incomplete, or missing the user's intent, ask one brief clarifying question instead of guessing.",
	"- If the request needs deeper reasoning, current information, or tools, use the available tools before answering.",
	"- Do not call the tts tool; Discord voice will synthesize and play the returned text.",
	"- Do not reply with NO_REPLY unless no spoken response is appropriate.",
	"- Keep the response brief, natural, and conversational. Prefer one to three short sentences.",
	"- Avoid markdown tables, code fences, citations, and visual formatting unless the user explicitly asks for something that cannot be spoken naturally."
].join("\n");
function formatVoiceIngressPrompt(transcript, speakerLabel) {
	const cleanedTranscript = transcript.trim();
	const cleanedLabel = speakerLabel?.trim();
	return [DISCORD_VOICE_SPOKEN_OUTPUT_CONTRACT, cleanedLabel ? [`Voice transcript from speaker "${cleanedLabel}":`, cleanedTranscript].join("\n") : cleanedTranscript].join("\n\n");
}
//#endregion
//#region extensions/discord/src/voice/sdk-runtime.ts
let cachedDiscordVoiceSdk = null;
function loadDiscordVoiceSdk() {
	if (cachedDiscordVoiceSdk) return cachedDiscordVoiceSdk;
	cachedDiscordVoiceSdk = createRequire(import.meta.url)("@discordjs/voice");
	return cachedDiscordVoiceSdk;
}
const CAPTURE_FINALIZE_GRACE_MS = 2500;
const VOICE_CONNECT_READY_TIMEOUT_MS = 3e4;
const VOICE_RECONNECT_GRACE_MS = 15e3;
const PLAYBACK_READY_TIMEOUT_MS = 6e4;
const SPEAKING_READY_TIMEOUT_MS = 6e4;
function resolveVoiceTimeoutMs(value, fallbackMs) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallbackMs;
	return Math.floor(value);
}
function logVoiceVerbose(message) {
	logVerbose(`discord voice: ${message}`);
}
function isVoiceChannel(type) {
	return type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice;
}
//#endregion
//#region extensions/discord/src/voice/realtime.ts
const logger$2 = createSubsystemLogger("discord/voice");
const DISCORD_REALTIME_TALKBACK_DEBOUNCE_MS = 350;
const DISCORD_REALTIME_FALLBACK_TEXT = "I hit an error while checking that. Please try again.";
const DISCORD_REALTIME_PENDING_SPEAKER_CONTEXT_LIMIT = 32;
const DISCORD_REALTIME_RECENT_AGENT_PROXY_CONSULT_LIMIT = 16;
const DISCORD_REALTIME_RECENT_AGENT_PROXY_CONSULT_TTL_MS = 15e3;
const DISCORD_REALTIME_LOG_PREVIEW_CHARS = 500;
const DISCORD_REALTIME_DEFAULT_MIN_BARGE_IN_AUDIO_END_MS = 250;
const DISCORD_REALTIME_FORCED_CONSULT_FALLBACK_DELAY_MS = 200;
const DISCORD_REALTIME_DUPLICATE_ERROR_SUPPRESS_MS = 6e4;
const REALTIME_PCM16_BYTES_PER_SAMPLE = 2;
const DISCORD_RAW_PCM_FRAME_BYTES = 3840;
const DISCORD_REALTIME_OUTPUT_PREROLL_FRAMES = 25;
const DISCORD_REALTIME_TRAILING_SILENCE_MIN_MS = 700;
const DISCORD_REALTIME_TRAILING_SILENCE_MAX_MS = 3e3;
const DISCORD_REALTIME_FORCED_CONSULT_TRAILING_FRAGMENT_WORDS = new Set([
	"a",
	"about",
	"an",
	"and",
	"as",
	"at",
	"because",
	"but",
	"by",
	"for",
	"from",
	"in",
	"of",
	"on",
	"or",
	"so",
	"that",
	"the",
	"then",
	"to",
	"with"
]);
const DISCORD_REALTIME_VERBOSE_OMITTED_EVENTS = new Set([
	"conversation.output_audio.delta",
	"input_audio_buffer.append",
	"response.audio.delta",
	"response.output_audio.delta"
]);
function formatRealtimeLogPreview(text) {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= DISCORD_REALTIME_LOG_PREVIEW_CHARS) return oneLine;
	return `${oneLine.slice(0, DISCORD_REALTIME_LOG_PREVIEW_CHARS)}...`;
}
function formatRealtimeInterruptionLog(event) {
	const detail = event.detail ? ` ${event.detail}` : "";
	if (event.direction === "client") {
		if (event.type === "response.cancel") return `discord voice: realtime model interrupt requested ${event.direction}:${event.type}${detail}`;
		if (event.type === "conversation.item.truncate.skipped") return `discord voice: realtime model interrupt ignored ${event.direction}:${event.type}${detail}`;
		if (event.type === "conversation.item.truncate") return `discord voice: realtime model audio truncated ${event.direction}:${event.type}${detail}`;
	}
	if (event.direction === "server") {
		if (event.type === "response.cancelled") return `discord voice: realtime model interrupt confirmed ${event.direction}:${event.type}${detail}`;
		if (event.type === "response.done" && event.detail?.includes("status=cancelled")) return `discord voice: realtime model interrupt confirmed ${event.direction}:${event.type}${detail}`;
		if (event.type === "error" && event.detail === "Cancellation failed: no active response found") return `discord voice: realtime model interrupt raced ${event.direction}:${event.type}${detail}`;
	}
}
function isRealtimeResponseCancelled(event) {
	return event.direction === "server" && (event.type === "response.cancelled" || event.type === "response.done" && event.detail?.includes("status=cancelled") === true);
}
function shouldLogRealtimeVerboseEvent(event) {
	return !DISCORD_REALTIME_VERBOSE_OMITTED_EVENTS.has(event.type);
}
function classifySkippableForcedAgentProxyTranscript(text) {
	const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
	if (!normalized) return "empty";
	if (/(\.\.\.|…)\s*$/.test(normalized)) return "incomplete-transcript";
	const lastWord = normalized.match(/[a-z']+$/)?.[0]?.replace(/^'+|'+$/g, "");
	if (lastWord && DISCORD_REALTIME_FORCED_CONSULT_TRAILING_FRAGMENT_WORDS.has(lastWord)) return "trailing-fragment";
	if (!normalized.includes("?") && (/^(i'?ll|i will) be (right )?back\b/.test(normalized) || /\b(see you|bye(?:-bye)?|goodbye)\b/.test(normalized))) return "non-actionable-closing";
}
function readProviderConfigString(config, key) {
	const value = config[key];
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function readProviderConfigBoolean(config, key) {
	const value = config?.[key];
	return typeof value === "boolean" ? value : void 0;
}
function resolveDiscordVoiceMode(voice) {
	const mode = voice?.mode;
	if (mode === "stt-tts" || mode === "bidi") return mode;
	return "agent-proxy";
}
function isDiscordRealtimeVoiceMode(mode) {
	return mode === "agent-proxy" || mode === "bidi";
}
function isDiscordAgentProxyVoiceMode(mode) {
	return mode === "agent-proxy";
}
function resolveDiscordRealtimeInterruptResponseOnInputAudio(params) {
	const providerConfig = params.realtimeConfig?.providers?.[params.providerId];
	return readProviderConfigBoolean(providerConfig, "interruptResponseOnInputAudio") ?? true;
}
function resolveDiscordRealtimeBargeIn(params) {
	const configured = params.realtimeConfig?.bargeIn;
	if (typeof configured === "boolean") return configured;
	return resolveDiscordRealtimeInterruptResponseOnInputAudio(params);
}
function buildDiscordSpeakExactUserMessage(text) {
	return [
		"Internal OpenClaw voice playback result.",
		"Do not call openclaw_agent_consult or any other tool for this message.",
		"Speak this exact OpenClaw answer to the Discord voice channel, without adding, removing, or rephrasing words.",
		`Answer: ${JSON.stringify(text)}`
	].join("\n");
}
function isEscapedQuote(text, quoteIndex) {
	let backslashes = 0;
	for (let index = quoteIndex - 1; index >= 0 && text[index] === "\\"; index -= 1) backslashes += 1;
	return backslashes % 2 === 1;
}
function readJsonStringAfterLabel(text, label) {
	const labelIndex = text.indexOf(label);
	if (labelIndex < 0) return;
	const quoteIndex = text.indexOf("\"", labelIndex + label.length);
	if (quoteIndex < 0) return;
	for (let index = quoteIndex + 1; index < text.length; index += 1) {
		if (text[index] !== "\"" || isEscapedQuote(text, index)) continue;
		try {
			const parsed = JSON.parse(text.slice(quoteIndex, index + 1));
			return typeof parsed === "string" ? parsed : void 0;
		} catch {
			return;
		}
	}
}
function collectRealtimeConsultArgStrings(args) {
	if (!args || typeof args !== "object") return typeof args === "string" ? [args] : [];
	const values = [];
	for (const key of [
		"question",
		"prompt",
		"query",
		"task",
		"context",
		"responseStyle"
	]) {
		const value = args[key];
		if (typeof value === "string") values.push(value);
	}
	return values;
}
function extractDiscordExactSpeechConsultText(args) {
	const message = collectRealtimeConsultArgStrings(args).join("\n");
	if (!message.includes("Speak this exact OpenClaw answer") && !message.includes("Speak the provided exact answer verbatim")) return;
	return readJsonStringAfterLabel(message, "Answer:") ?? readJsonStringAfterLabel(message, "Provided answer text:");
}
function normalizeRealtimeConsultMatchText(text) {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}
function matchesPendingAgentProxyQuestion(consultMessage, question) {
	const normalizedConsult = normalizeRealtimeConsultMatchText(consultMessage);
	const normalizedQuestion = normalizeRealtimeConsultMatchText(question);
	if (!normalizedConsult || !normalizedQuestion) return false;
	return normalizedConsult.includes(normalizedQuestion) || normalizedQuestion.includes(normalizedConsult);
}
var DiscordRealtimeVoiceSession = class {
	constructor(params) {
		this.params = params;
		this.bridge = null;
		this.outputStream = null;
		this.stopped = false;
		this.consultToolPolicy = "safe-read-only";
		this.consultPolicy = "auto";
		this.pendingAgentProxyConsultContexts = [];
		this.recentAgentProxyConsultContexts = [];
		this.pendingSpeakerTurns = [];
		this.outputAudioTimestampMs = 0;
		this.outputAudioDiscordBytes = 0;
		this.outputAudioRealtimeBytes = 0;
		this.outputAudioChunks = 0;
		this.outputStreamEnding = false;
		this.outputPacedBuffer = Buffer.alloc(0);
		this.outputPlaybackStarted = false;
		this.queuedExactSpeechMessages = [];
		this.exactSpeechResponseActive = false;
		this.exactSpeechAudioStarted = false;
		this.playerIdleHandler = () => {
			this.resetOutputStream("player-idle");
			this.completeExactSpeechResponse("player-idle");
		};
		this.talkback = createRealtimeVoiceAgentTalkbackQueue({
			debounceMs: this.realtimeConfig?.debounceMs ?? DISCORD_REALTIME_TALKBACK_DEBOUNCE_MS,
			isStopped: () => this.stopped,
			logger: logger$2,
			logPrefix: "[discord] realtime agent",
			responseStyle: "Brief, natural spoken answer for a Discord voice channel.",
			fallbackText: DISCORD_REALTIME_FALLBACK_TEXT,
			consult: async ({ question, responseStyle, metadata }) => {
				const context = isDiscordRealtimeSpeakerContext(metadata) ? metadata : void 0;
				return { text: await this.runAgentTurn({
					context,
					message: formatVoiceIngressPrompt([question, responseStyle ? `Spoken style: ${responseStyle}` : void 0].filter(Boolean).join("\n\n"), context?.speakerLabel ?? "Discord voice speaker")
				}) };
			},
			deliver: (text) => this.enqueueExactSpeechMessage(text)
		});
	}
	async connect() {
		const resolved = resolveConfiguredRealtimeVoiceProvider({
			configuredProviderId: this.realtimeConfig?.provider,
			providerConfigs: buildProviderConfigs(this.realtimeConfig),
			providerConfigOverrides: buildProviderConfigOverrides(this.realtimeConfig),
			cfg: this.params.cfg,
			defaultModel: this.realtimeConfig?.model,
			noRegisteredProviderMessage: "No configured realtime voice provider registered"
		});
		this.realtimeProviderId = resolved.provider.id;
		const isAgentProxy = isDiscordAgentProxyVoiceMode(this.params.mode);
		const defaultToolPolicy = isAgentProxy ? "owner" : "safe-read-only";
		const toolPolicy = resolveRealtimeVoiceAgentConsultToolPolicy(this.realtimeConfig?.toolPolicy, defaultToolPolicy);
		this.consultToolPolicy = toolPolicy;
		this.consultToolsAllow = resolveRealtimeVoiceAgentConsultToolsAllow(toolPolicy);
		const consultPolicy = this.realtimeConfig?.consultPolicy ?? (isAgentProxy ? "always" : "auto");
		this.consultPolicy = consultPolicy;
		const usesRealtimeAgentHandoff = this.params.mode === "bidi" || toolPolicy !== "none";
		const autoRespondToAudio = !isAgentProxy || consultPolicy !== "always";
		const interruptResponseOnInputAudio = resolveDiscordRealtimeInterruptResponseOnInputAudio({
			realtimeConfig: this.realtimeConfig,
			providerId: resolved.provider.id
		});
		const instructions = buildDiscordRealtimeInstructions({
			mode: this.params.mode,
			instructions: this.realtimeConfig?.instructions,
			bootstrapContextInstructions: this.params.bootstrapContextInstructions,
			toolPolicy,
			consultPolicy
		});
		this.bridge = createRealtimeVoiceBridgeSession({
			provider: resolved.provider,
			providerConfig: resolved.providerConfig,
			audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
			instructions,
			autoRespondToAudio,
			interruptResponseOnInputAudio,
			markStrategy: "ack-immediately",
			tools: usesRealtimeAgentHandoff ? resolveRealtimeVoiceAgentConsultTools(toolPolicy) : [],
			audioSink: {
				isOpen: () => !this.stopped,
				sendAudio: (audio) => this.sendOutputAudio(audio),
				clearAudio: () => this.clearOutputAudio("provider-clear-audio")
			},
			onTranscript: (role, text, isFinal) => {
				if (isFinal && text.trim()) logger$2.info(`discord voice: realtime ${role} transcript (${text.length} chars): ${formatRealtimeLogPreview(text)}`);
				if (!isFinal || role !== "user" || !isDiscordAgentProxyVoiceMode(this.params.mode)) return;
				if (usesRealtimeAgentHandoff) {
					this.scheduleForcedAgentProxyConsult(text);
					return;
				}
				this.talkback.enqueue(text, this.consumePendingSpeakerContext());
			},
			onToolCall: (event, session) => this.handleToolCall(event, session),
			onEvent: (event) => {
				const detail = event.detail ? ` ${event.detail}` : "";
				if (shouldLogRealtimeVerboseEvent(event)) logVoiceVerbose(`realtime ${event.direction}:${event.type}${detail}`);
				if (event.direction === "server" && (event.type === "response.done" || event.type === "response.cancelled")) {
					if (this.exactSpeechResponseActive && !this.exactSpeechAudioStarted) this.completeExactSpeechResponse(event.type);
					this.finishOutputAudioStream(event.type, { playBuffered: !isRealtimeResponseCancelled(event) });
				}
				const interruptionLog = formatRealtimeInterruptionLog(event);
				if (interruptionLog) logger$2.info(interruptionLog);
			},
			onError: (error) => this.logRealtimeError(formatErrorMessage(error)),
			onClose: (reason) => {
				this.flushSuppressedRealtimeErrors();
				logVoiceVerbose(`realtime closed: ${reason}`);
			}
		});
		const resolvedModel = readProviderConfigString(resolved.providerConfig, "model") ?? resolved.provider.defaultModel;
		const resolvedVoice = readProviderConfigString(resolved.providerConfig, "voice");
		logger$2.info(`discord voice: realtime bridge starting mode=${this.params.mode} provider=${resolved.provider.id} model=${resolvedModel ?? "default"} voice=${resolvedVoice ?? "default"} consultPolicy=${consultPolicy} toolPolicy=${toolPolicy} autoRespond=${autoRespondToAudio} interruptResponse=${interruptResponseOnInputAudio} bargeIn=${resolveDiscordRealtimeBargeIn({
			realtimeConfig: this.realtimeConfig,
			providerId: resolved.provider.id
		})} minBargeInAudioEndMs=${resolveDiscordRealtimeMinBargeInAudioEndMs(this.realtimeConfig)}`);
		const voiceSdk = loadDiscordVoiceSdk();
		this.params.entry.player.on(voiceSdk.AudioPlayerStatus.Idle, this.playerIdleHandler);
		await this.bridge.connect();
		logger$2.info(`discord voice: realtime bridge ready mode=${this.params.mode} provider=${resolved.provider.id} model=${resolvedModel ?? "default"} voice=${resolvedVoice ?? "default"}`);
	}
	close() {
		this.stopped = true;
		this.flushSuppressedRealtimeErrors();
		this.talkback.close();
		this.clearForcedConsultTimers();
		this.pendingAgentProxyConsultContexts = [];
		this.recentAgentProxyConsultContexts = [];
		this.pendingSpeakerTurns.length = 0;
		this.queuedExactSpeechMessages = [];
		this.exactSpeechResponseActive = false;
		this.exactSpeechAudioStarted = false;
		this.clearOutputAudio("session-close");
		this.bridge?.close();
		this.bridge = null;
		this.realtimeProviderId = void 0;
		const voiceSdk = loadDiscordVoiceSdk();
		this.params.entry.player.off(voiceSdk.AudioPlayerStatus.Idle, this.playerIdleHandler);
	}
	logRealtimeError(message) {
		const now = Date.now();
		if (this.lastRealtimeError?.message === message && now - this.lastRealtimeError.lastLoggedAt < DISCORD_REALTIME_DUPLICATE_ERROR_SUPPRESS_MS) {
			this.lastRealtimeError.suppressed += 1;
			return;
		}
		this.flushSuppressedRealtimeErrors();
		this.lastRealtimeError = {
			message,
			suppressed: 0,
			lastLoggedAt: now
		};
		logger$2.warn(`discord voice: realtime error: ${message}`);
	}
	flushSuppressedRealtimeErrors() {
		if (!this.lastRealtimeError || this.lastRealtimeError.suppressed === 0) return;
		logger$2.warn(`discord voice: suppressed ${this.lastRealtimeError.suppressed} duplicate realtime errors: ${this.lastRealtimeError.message}`);
		this.lastRealtimeError.suppressed = 0;
	}
	beginSpeakerTurn(context, userId) {
		const turn = {
			context: {
				...context,
				userId
			},
			hasAudio: false,
			inputDiscordBytes: 0,
			inputRealtimeBytes: 0,
			inputChunks: 0,
			interruptedPlayback: false,
			closed: false,
			startedAt: Date.now()
		};
		this.pendingSpeakerTurns.push(turn);
		logger$2.info(`discord voice: realtime speaker turn opened guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} user=${userId} speaker=${context.speakerLabel} owner=${context.senderIsOwner} pendingTurns=${this.pendingSpeakerTurns.length}`);
		this.prunePendingSpeakerTurns();
		return {
			sendInputAudio: (discordPcm48kStereo) => this.sendInputAudioForTurn(turn, discordPcm48kStereo),
			close: () => {
				this.sendRealtimeTrailingSilenceForTurn(turn);
				this.logSpeakerTurnClosed(turn);
				turn.closed = true;
				this.prunePendingSpeakerTurns();
			}
		};
	}
	sendInputAudioForTurn(turn, discordPcm48kStereo) {
		if (!this.bridge || this.stopped) return;
		turn.hasAudio = true;
		const realtimePcm = convertDiscordPcm48kStereoToRealtimePcm24kMono(discordPcm48kStereo);
		if (realtimePcm.length > 0) {
			turn.inputDiscordBytes += discordPcm48kStereo.length;
			turn.inputRealtimeBytes += realtimePcm.length;
			turn.inputChunks += 1;
			turn.lastAudioAt = Date.now();
			if (turn.inputChunks === 1) logger$2.info(`discord voice: realtime input audio started guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} user=${turn.context.userId} speaker=${turn.context.speakerLabel} discordBytes=${discordPcm48kStereo.length} realtimeBytes=${realtimePcm.length} outputAudioMs=${Math.floor(this.outputAudioTimestampMs)} outputActive=${this.isOutputAudioActive()}`);
			const outputActive = this.hasInterruptibleOutputAudio();
			if (!turn.interruptedPlayback && this.isBargeInEnabled() && outputActive) {
				turn.interruptedPlayback = true;
				logVoiceVerbose(`realtime barge-in from active speaker audio: guild ${this.params.entry.guildId} channel ${this.params.entry.channelId} user ${turn.context.userId}`);
				logger$2.info(`discord voice: realtime barge-in detected source=active-speaker-audio guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} user=${turn.context.userId} speaker=${turn.context.speakerLabel} outputAudioMs=${Math.floor(this.outputAudioTimestampMs)} outputActive=${this.isOutputAudioActive()} discordBytes=${discordPcm48kStereo.length} realtimeBytes=${realtimePcm.length}`);
				this.handleBargeIn("active-speaker-audio");
			}
			this.bridge.sendAudio(realtimePcm);
		}
	}
	handleBargeIn(reason = "barge-in") {
		if (!this.isBargeInEnabled()) {
			logger$2.info(`discord voice: realtime barge-in ignored reason=${reason} bargeIn=false guild=${this.params.entry.guildId} channel=${this.params.entry.channelId}`);
			return;
		}
		if (!this.hasInterruptibleOutputAudio()) {
			logger$2.info(`discord voice: realtime barge-in ignored reason=${reason} outputActive=false guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} playbackChunks=${this.outputAudioChunks}`);
			return;
		}
		logger$2.info(`discord voice: realtime barge-in requested reason=${reason} guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} outputAudioMs=${Math.floor(this.outputAudioTimestampMs)} outputActive=${this.isOutputAudioActive()} playbackChunks=${this.outputAudioChunks}`);
		this.bridge?.handleBargeIn({ audioPlaybackActive: true });
	}
	isBargeInEnabled() {
		const providerId = this.realtimeProviderId ?? this.realtimeConfig?.provider ?? "openai";
		return resolveDiscordRealtimeBargeIn({
			realtimeConfig: this.realtimeConfig,
			providerId
		});
	}
	hasInterruptibleOutputAudio() {
		this.syncOutputAudioTimestamp();
		return this.isOutputAudioActive() || this.outputAudioChunks > 0 || this.outputAudioTimestampMs > 0;
	}
	get realtimeConfig() {
		return this.params.discordConfig.voice?.realtime;
	}
	sendOutputAudio(realtimePcm24kMono) {
		const discordPcm = convertRealtimePcm24kMonoToDiscordPcm48kStereo(realtimePcm24kMono);
		if (discordPcm.length === 0) return;
		this.syncOutputAudioTimestamp();
		if (this.outputStreamEnding) {
			logVoiceVerbose(`realtime output audio ignored after stream ending: guild ${this.params.entry.guildId} channel ${this.params.entry.channelId}`);
			return;
		}
		const stream = this.ensureOutputStream();
		if (this.exactSpeechResponseActive) this.exactSpeechAudioStarted = true;
		this.outputAudioDiscordBytes += discordPcm.length;
		this.outputAudioRealtimeBytes += realtimePcm24kMono.length;
		this.outputAudioChunks += 1;
		this.outputAudioTimestampMs += pcm16MonoDurationMs(realtimePcm24kMono, REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz);
		this.queueOutputAudio(stream, discordPcm);
	}
	ensureOutputStream() {
		if (this.outputStream && !this.outputStream.destroyed && !this.outputStream.writableEnded) return this.outputStream;
		const stream = new PassThrough({ highWaterMark: DISCORD_RAW_PCM_FRAME_BYTES * 128 });
		this.outputStream = stream;
		this.outputPacedBuffer = Buffer.alloc(0);
		this.outputPlaybackStarted = false;
		stream.once("close", () => {
			if (this.outputStream === stream) {
				this.logOutputAudioStopped("stream-close");
				this.outputStream = null;
				this.resetOutputAudioStats();
				this.completeExactSpeechResponse("stream-close", { drain: false });
			}
		});
		return stream;
	}
	queueOutputAudio(stream, discordPcm) {
		if (this.outputPlaybackStarted) {
			stream.write(discordPcm);
			return;
		}
		this.outputPacedBuffer = this.outputPacedBuffer.length > 0 ? Buffer.concat([this.outputPacedBuffer, discordPcm]) : discordPcm;
		if (this.outputPacedBuffer.length >= DISCORD_RAW_PCM_FRAME_BYTES * DISCORD_REALTIME_OUTPUT_PREROLL_FRAMES) this.startOutputPlayback(stream);
	}
	startOutputPlayback(stream) {
		if (this.outputPlaybackStarted || stream.destroyed) return;
		const voiceSdk = loadDiscordVoiceSdk();
		if (this.outputPacedBuffer.length > 0) {
			stream.write(this.outputPacedBuffer);
			this.outputPacedBuffer = Buffer.alloc(0);
		}
		const resource = voiceSdk.createAudioResource(stream, { inputType: voiceSdk.StreamType.Raw });
		this.params.entry.player.play(resource);
		this.outputPlaybackStarted = true;
		this.outputAudioStartedAt = Date.now();
		const realtimeConfig = this.realtimeConfig;
		logger$2.info(`discord voice: realtime audio playback started guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} mode=${this.params.mode} model=${realtimeConfig?.model ?? "provider-default"} voice=${realtimeConfig?.voice ?? "provider-default"}`);
	}
	clearOutputAudio(reason = "clear") {
		this.resetOutputStream(reason);
		this.params.entry.player.stop(true);
	}
	resetOutputStream(reason = "reset") {
		const stream = this.outputStream;
		this.logOutputAudioStopped(reason);
		this.outputStream = null;
		this.outputPacedBuffer = Buffer.alloc(0);
		this.outputPlaybackStarted = false;
		this.resetOutputAudioStats();
		stream?.end();
		stream?.destroy();
	}
	finishOutputAudioStream(reason, { playBuffered = true } = {}) {
		const stream = this.outputStream;
		if (!stream || stream.destroyed || this.outputStreamEnding) return;
		this.outputStreamEnding = true;
		logger$2.info(`discord voice: realtime audio playback finishing reason=${reason} guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} audioMs=${Math.floor(this.outputAudioTimestampMs)} chunks=${this.outputAudioChunks}`);
		if (playBuffered) this.startOutputPlayback(stream);
		else {
			this.resetOutputStream(reason);
			this.params.entry.player.stop(true);
			this.completeExactSpeechResponse(reason);
			return;
		}
		stream.end();
	}
	enqueueExactSpeechMessage(text) {
		if (this.stopped || !text.trim()) return;
		if (this.exactSpeechResponseActive || this.hasInterruptibleOutputAudio()) {
			this.queuedExactSpeechMessages.push(text);
			logger$2.info(`discord voice: realtime exact speech queued guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} queued=${this.queuedExactSpeechMessages.length} outputAudioMs=${Math.floor(this.outputAudioTimestampMs)} outputActive=${this.isOutputAudioActive()}`);
			return;
		}
		this.sendExactSpeechMessage(text);
	}
	sendExactSpeechMessage(text) {
		if (this.stopped || !text.trim()) return;
		this.exactSpeechResponseActive = true;
		this.exactSpeechAudioStarted = false;
		this.bridge?.sendUserMessage(buildDiscordSpeakExactUserMessage(text));
	}
	completeExactSpeechResponse(reason, options) {
		if (!this.exactSpeechResponseActive && this.queuedExactSpeechMessages.length === 0) return;
		this.exactSpeechResponseActive = false;
		this.exactSpeechAudioStarted = false;
		if (options?.drain === false) return;
		this.drainQueuedExactSpeechMessages(reason);
	}
	drainQueuedExactSpeechMessages(reason) {
		if (this.stopped || this.exactSpeechResponseActive || this.queuedExactSpeechMessages.length === 0 || this.hasInterruptibleOutputAudio()) return;
		const next = this.queuedExactSpeechMessages.shift();
		if (!next) return;
		logger$2.info(`discord voice: realtime exact speech dequeued reason=${reason} guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} queued=${this.queuedExactSpeechMessages.length}`);
		this.sendExactSpeechMessage(next);
	}
	logOutputAudioStopped(reason) {
		const audioMs = Math.floor(this.outputAudioTimestampMs);
		const chunks = this.outputAudioChunks;
		const discordBytes = this.outputAudioDiscordBytes;
		const realtimeBytes = this.outputAudioRealtimeBytes;
		const elapsedMs = this.outputAudioStartedAt ? Date.now() - this.outputAudioStartedAt : 0;
		if (this.outputStream || chunks > 0 || audioMs > 0) logger$2.info(`discord voice: realtime audio playback stopped reason=${reason} guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} audioMs=${audioMs} elapsedMs=${elapsedMs} chunks=${chunks} discordBytes=${discordBytes} realtimeBytes=${realtimeBytes}`);
	}
	resetOutputAudioStats() {
		this.outputAudioTimestampMs = 0;
		this.outputAudioDiscordBytes = 0;
		this.outputAudioRealtimeBytes = 0;
		this.outputAudioChunks = 0;
		this.outputAudioStartedAt = void 0;
		this.outputStreamEnding = false;
		this.outputPacedBuffer = Buffer.alloc(0);
		this.outputPlaybackStarted = false;
	}
	syncOutputAudioTimestamp() {
		this.bridge?.setMediaTimestamp(Math.floor(this.outputAudioTimestampMs));
	}
	isOutputAudioActive() {
		return Boolean(this.outputStream && !this.outputStream.destroyed) || this.outputAudioChunks > 0;
	}
	logSpeakerTurnClosed(turn) {
		if (turn.closed) return;
		const elapsedMs = Date.now() - turn.startedAt;
		const sinceLastAudioMs = turn.lastAudioAt ? Date.now() - turn.lastAudioAt : void 0;
		logger$2.info(`discord voice: realtime speaker turn closed guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} user=${turn.context.userId} speaker=${turn.context.speakerLabel} owner=${turn.context.senderIsOwner} hasAudio=${turn.hasAudio} chunks=${turn.inputChunks} discordBytes=${turn.inputDiscordBytes} realtimeBytes=${turn.inputRealtimeBytes} elapsedMs=${elapsedMs}${sinceLastAudioMs === void 0 ? "" : ` sinceLastAudioMs=${sinceLastAudioMs}`} interruptedPlayback=${turn.interruptedPlayback}`);
	}
	sendRealtimeTrailingSilenceForTurn(turn) {
		if (!this.bridge || this.stopped || turn.closed || !turn.hasAudio) return;
		const providerId = this.realtimeProviderId ?? this.realtimeConfig?.provider ?? "openai";
		const rawSilenceDurationMs = (this.realtimeConfig?.providers?.[providerId])?.silenceDurationMs;
		const silenceMs = Math.min(DISCORD_REALTIME_TRAILING_SILENCE_MAX_MS, Math.max(DISCORD_REALTIME_TRAILING_SILENCE_MIN_MS, typeof rawSilenceDurationMs === "number" && Number.isFinite(rawSilenceDurationMs) ? rawSilenceDurationMs : 0));
		const silenceBytes = Math.ceil(REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz * silenceMs / 1e3) * REALTIME_PCM16_BYTES_PER_SAMPLE;
		const silence = Buffer.alloc(silenceBytes);
		this.bridge.sendAudio(silence);
		logger$2.info(`discord voice: realtime trailing silence sent guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} user=${turn.context.userId} speaker=${turn.context.speakerLabel} silenceMs=${silenceMs} realtimeBytes=${silence.length}`);
	}
	handleToolCall(event, session) {
		const callId = event.callId || event.itemId || "unknown";
		if (event.name !== "openclaw_agent_consult") {
			session.submitToolResult(callId, { error: `Tool "${event.name}" not available` });
			return;
		}
		if (this.consultToolPolicy === "none") {
			session.submitToolResult(callId, { error: `Tool "${event.name}" not available` });
			return;
		}
		const exactSpeechText = extractDiscordExactSpeechConsultText(event.args);
		if (exactSpeechText !== void 0) {
			logger$2.info(`discord voice: realtime exact speech consult bypassed call=${callId || "unknown"} answerChars=${exactSpeechText.length}`);
			session.submitToolResult(callId, { text: exactSpeechText });
			return;
		}
		const consultMessage = buildRealtimeVoiceAgentConsultChatMessage(event.args);
		logger$2.info(`discord voice: realtime consult requested call=${callId || "unknown"} voiceSession=${this.params.entry.voiceSessionKey} supervisorSession=${this.params.entry.route.sessionKey} agent=${this.params.entry.route.agentId} question=${formatRealtimeLogPreview(consultMessage)}`);
		if (session.bridge.supportsToolResultContinuation) session.submitToolResult(callId, buildRealtimeVoiceAgentConsultWorkingResponse("speaker"), { willContinue: true });
		const pendingConsultContext = this.consumeAgentProxyConsultContext(consultMessage);
		if (pendingConsultContext) this.addRecentAgentProxyConsultQuestion(pendingConsultContext.recent, consultMessage);
		let context = pendingConsultContext?.context;
		let recent = pendingConsultContext?.recent;
		if (!context) {
			const recentConsult = this.findRecentAgentProxyConsultContext(consultMessage);
			if (recentConsult) {
				if (this.hasPendingSpeakerAudioContext()) {
					logger$2.info(`discord voice: realtime consult matched recent agent result but newer speaker audio is pending call=${callId} speaker=${recentConsult.context.speakerLabel} owner=${recentConsult.context.senderIsOwner}`);
					session.submitToolResult(callId, { error: "Discord speaker context changed before this realtime consult completed" });
					return;
				}
				if (this.submitRecentAgentProxyConsultResult(callId, recentConsult, session)) return;
			}
		}
		if (!context) {
			context = this.consumePendingSpeakerContext();
			if (context) recent = this.rememberRecentAgentProxyConsultContext(consultMessage, context);
		}
		if (!context) {
			logger$2.warn(`discord voice: realtime consult has no speaker context call=${callId || "unknown"}`);
			session.submitToolResult(callId, { error: "No Discord speaker context available" });
			return;
		}
		const promise = this.runAgentTurn({
			context,
			message: consultMessage
		});
		if (recent) this.setRecentAgentProxyConsultPromise(recent, promise);
		promise.then((text) => {
			logger$2.info(`discord voice: realtime consult answer (${text.length} chars) voiceSession=${this.params.entry.voiceSessionKey} supervisorSession=${this.params.entry.route.sessionKey} agent=${this.params.entry.route.agentId} speaker=${context.speakerLabel} owner=${context.senderIsOwner}: ${formatRealtimeLogPreview(text)}`);
			session.submitToolResult(callId, { text });
		}).catch((error) => {
			logger$2.warn(`discord voice: realtime consult failed call=${callId || "unknown"}: ${formatErrorMessage(error)}`);
			session.submitToolResult(callId, { error: formatErrorMessage(error) });
		});
	}
	async runAgentTurn(params) {
		const context = params.context;
		if (!context) return "";
		return this.params.runAgentTurn({
			context,
			message: params.message,
			toolsAllow: this.consultToolsAllow,
			userId: context.userId
		});
	}
	scheduleForcedAgentProxyConsult(transcript) {
		if (this.consultPolicy !== "always") return;
		const question = transcript.trim();
		if (!question) return;
		const context = this.consumePendingSpeakerContext();
		const skipReason = classifySkippableForcedAgentProxyTranscript(question);
		if (skipReason) {
			logger$2.info(`discord voice: realtime forced agent consult skipped reason=${skipReason} chars=${question.length} speaker=${context?.speakerLabel ?? "unknown"} transcript=${formatRealtimeLogPreview(question)}`);
			return;
		}
		if (!context) {
			const recent = this.findRecentAgentProxyConsultContext(question);
			if (recent) {
				logVoiceVerbose(`realtime forced agent consult skipped (already delegated): guild ${this.params.entry.guildId} channel ${this.params.entry.channelId} speaker ${recent.context.userId}`);
				return;
			}
			logger$2.warn("discord voice: realtime forced agent consult has no speaker context");
			return;
		}
		const pending = {
			context,
			question,
			recent: this.rememberRecentAgentProxyConsultContext(question, context)
		};
		this.pendingAgentProxyConsultContexts.push(pending);
		pending.timer = setTimeout(() => {
			pending.timer = void 0;
			this.runForcedAgentProxyConsult(pending);
		}, DISCORD_REALTIME_FORCED_CONSULT_FALLBACK_DELAY_MS);
		pending.timer.unref?.();
	}
	clearForcedConsultTimers() {
		for (const pending of this.pendingAgentProxyConsultContexts) this.clearForcedConsultTimer(pending);
	}
	clearForcedConsultTimer(pending) {
		if (!pending.timer) return;
		clearTimeout(pending.timer);
		pending.timer = void 0;
	}
	consumeAgentProxyConsultContext(consultMessage) {
		let pending;
		if (this.pendingAgentProxyConsultContexts.length === 1) pending = this.pendingAgentProxyConsultContexts.shift();
		else if (this.pendingAgentProxyConsultContexts.length > 1) {
			const index = this.pendingAgentProxyConsultContexts.findIndex((candidate) => matchesPendingAgentProxyQuestion(consultMessage, candidate.question));
			if (index < 0) return;
			pending = this.pendingAgentProxyConsultContexts.splice(index, 1)[0];
		}
		if (!pending) return;
		this.clearForcedConsultTimer(pending);
		return pending;
	}
	removePendingAgentProxyConsultContext(pending) {
		this.clearForcedConsultTimer(pending);
		const index = this.pendingAgentProxyConsultContexts.indexOf(pending);
		if (index >= 0) this.pendingAgentProxyConsultContexts.splice(index, 1);
	}
	async runForcedAgentProxyConsult(pending) {
		this.removePendingAgentProxyConsultContext(pending);
		const { context, question } = pending;
		if (this.stopped) return;
		const startedAt = Date.now();
		logger$2.info(`discord voice: realtime forced agent consult starting chars=${question.length} voiceSession=${this.params.entry.voiceSessionKey} supervisorSession=${this.params.entry.route.sessionKey} agent=${this.params.entry.route.agentId} speaker=${context.speakerLabel} owner=${context.senderIsOwner}`);
		if (this.hasInterruptibleOutputAudio()) logger$2.info(`discord voice: realtime forced agent consult preserving active playback guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} outputAudioMs=${Math.floor(this.outputAudioTimestampMs)} outputActive=${this.isOutputAudioActive()} playbackChunks=${this.outputAudioChunks}`);
		pending.recent.handledByForcedPlayback = true;
		try {
			const promise = this.runAgentTurn({
				context,
				message: [question, "Context: The realtime model produced a final user transcript without calling openclaw_agent_consult. OpenClaw is forcing the consult because consultPolicy is always."].join("\n\n")
			});
			this.setRecentAgentProxyConsultPromise(pending.recent, promise);
			const text = await promise;
			logger$2.info(`discord voice: realtime forced agent consult answer (${text.length} chars) elapsedMs=${Date.now() - startedAt} voiceSession=${this.params.entry.voiceSessionKey} supervisorSession=${this.params.entry.route.sessionKey} agent=${this.params.entry.route.agentId}: ${formatRealtimeLogPreview(text)}`);
			if (text.trim()) this.enqueueExactSpeechMessage(text);
		} catch (error) {
			logger$2.warn(`discord voice: realtime forced agent consult failed elapsedMs=${Date.now() - startedAt}: ${formatErrorMessage(error)}`);
			this.enqueueExactSpeechMessage(DISCORD_REALTIME_FALLBACK_TEXT);
		}
	}
	consumePendingSpeakerContext() {
		this.prunePendingSpeakerTurns();
		this.expireClosedSpeakerTurnsBeforeLaterAudio();
		const index = this.pendingSpeakerTurns.findIndex((turn) => turn.hasAudio);
		if (index < 0) return;
		const [turn] = this.pendingSpeakerTurns.splice(index, 1);
		this.prunePendingSpeakerTurns();
		return turn?.context;
	}
	hasPendingSpeakerAudioContext() {
		this.prunePendingSpeakerTurns();
		this.expireClosedSpeakerTurnsBeforeLaterAudio();
		return this.pendingSpeakerTurns.some((turn) => turn.hasAudio);
	}
	prunePendingSpeakerTurns() {
		for (let index = this.pendingSpeakerTurns.length - 1; index >= 0; index -= 1) {
			const turn = this.pendingSpeakerTurns[index];
			if (turn?.closed && !turn.hasAudio) this.pendingSpeakerTurns.splice(index, 1);
		}
		while (this.pendingSpeakerTurns.length > DISCORD_REALTIME_PENDING_SPEAKER_CONTEXT_LIMIT) {
			const completedIndex = this.pendingSpeakerTurns.findIndex((turn) => turn.closed);
			this.pendingSpeakerTurns.splice(Math.max(completedIndex, 0), 1);
		}
	}
	expireClosedSpeakerTurnsBeforeLaterAudio() {
		let hasLaterAudio = false;
		for (let index = this.pendingSpeakerTurns.length - 1; index >= 0; index -= 1) {
			const turn = this.pendingSpeakerTurns[index];
			if (!turn?.hasAudio) continue;
			if (turn.closed && hasLaterAudio) {
				this.pendingSpeakerTurns.splice(index, 1);
				continue;
			}
			hasLaterAudio = true;
		}
	}
	rememberRecentAgentProxyConsultContext(question, context) {
		this.pruneRecentAgentProxyConsultContexts();
		const recent = {
			context,
			createdAt: Date.now(),
			questions: [question]
		};
		this.recentAgentProxyConsultContexts.push(recent);
		this.pruneRecentAgentProxyConsultContexts();
		return recent;
	}
	addRecentAgentProxyConsultQuestion(recent, question) {
		if (recent.questions.some((candidate) => matchesPendingAgentProxyQuestion(question, candidate))) return;
		recent.questions.push(question);
	}
	setRecentAgentProxyConsultPromise(recent, promise) {
		recent.promise = promise;
		promise.then((text) => {
			recent.result = {
				status: "fulfilled",
				text
			};
		}).catch((error) => {
			recent.result = {
				status: "rejected",
				error: formatErrorMessage(error)
			};
		});
	}
	findRecentAgentProxyConsultContext(consultMessage) {
		this.pruneRecentAgentProxyConsultContexts();
		for (let index = this.recentAgentProxyConsultContexts.length - 1; index >= 0; index -= 1) {
			const recent = this.recentAgentProxyConsultContexts[index];
			if (recent?.questions.some((question) => matchesPendingAgentProxyQuestion(consultMessage, question))) return recent;
		}
	}
	submitRecentAgentProxyConsultResult(callId, recent, session) {
		const submitAlreadyDelivered = () => {
			session.submitToolResult(callId, {
				status: "already_delivered",
				message: "OpenClaw already delivered this answer to Discord voice."
			}, { suppressResponse: true });
		};
		const submitResult = (result) => {
			if (recent.handledByForcedPlayback) {
				submitAlreadyDelivered();
				return;
			}
			if (result.status === "fulfilled") {
				session.submitToolResult(callId, { text: result.text });
				return;
			}
			session.submitToolResult(callId, { error: result.error });
		};
		if (recent.result) {
			logger$2.info(`discord voice: realtime consult reused recent agent result call=${callId || "unknown"} speaker=${recent.context.speakerLabel} owner=${recent.context.senderIsOwner}`);
			submitResult(recent.result);
			return true;
		}
		if (!recent.promise) return false;
		logger$2.info(`discord voice: realtime consult joined in-flight agent result call=${callId || "unknown"} speaker=${recent.context.speakerLabel} owner=${recent.context.senderIsOwner}`);
		if (recent.handledByForcedPlayback) {
			recent.promise.then(submitAlreadyDelivered, submitAlreadyDelivered);
			return true;
		}
		recent.promise.then((text) => session.submitToolResult(callId, { text })).catch((error) => session.submitToolResult(callId, { error: formatErrorMessage(error) }));
		return true;
	}
	pruneRecentAgentProxyConsultContexts() {
		const minCreatedAt = Date.now() - DISCORD_REALTIME_RECENT_AGENT_PROXY_CONSULT_TTL_MS;
		for (let index = this.recentAgentProxyConsultContexts.length - 1; index >= 0; index -= 1) {
			const recent = this.recentAgentProxyConsultContexts[index];
			if (recent && recent.createdAt < minCreatedAt) this.recentAgentProxyConsultContexts.splice(index, 1);
		}
		while (this.recentAgentProxyConsultContexts.length > DISCORD_REALTIME_RECENT_AGENT_PROXY_CONSULT_LIMIT) this.recentAgentProxyConsultContexts.shift();
	}
};
function isDiscordRealtimeSpeakerContext(value) {
	return Boolean(value) && typeof value === "object" && typeof value.userId === "string" && typeof value.senderIsOwner === "boolean" && typeof value.speakerLabel === "string";
}
function pcm16MonoDurationMs(audio, sampleRate) {
	if (audio.length === 0 || sampleRate <= 0) return 0;
	return audio.length / REALTIME_PCM16_BYTES_PER_SAMPLE * 1e3 / sampleRate;
}
function buildProviderConfigs(realtimeConfig) {
	const configs = realtimeConfig?.providers;
	return configs && Object.keys(configs).length > 0 ? { ...configs } : void 0;
}
function buildProviderConfigOverrides(realtimeConfig) {
	const overrides = {
		...realtimeConfig?.model ? { model: realtimeConfig.model } : {},
		...realtimeConfig?.voice ? { voice: realtimeConfig.voice } : {},
		...typeof realtimeConfig?.minBargeInAudioEndMs === "number" ? { minBargeInAudioEndMs: realtimeConfig.minBargeInAudioEndMs } : {}
	};
	return Object.keys(overrides).length > 0 ? overrides : void 0;
}
function resolveDiscordRealtimeMinBargeInAudioEndMs(realtimeConfig) {
	return typeof realtimeConfig?.minBargeInAudioEndMs === "number" ? realtimeConfig.minBargeInAudioEndMs : DISCORD_REALTIME_DEFAULT_MIN_BARGE_IN_AUDIO_END_MS;
}
function buildDiscordRealtimeInstructions(params) {
	const base = params.instructions ?? ["You are OpenClaw's Discord voice interface.", "Keep spoken replies concise, natural, and suitable for a live Discord voice channel."].join("\n");
	if (isDiscordAgentProxyVoiceMode(params.mode)) return [
		base,
		params.bootstrapContextInstructions?.trim(),
		"Mode: OpenClaw agent proxy.",
		"You are the realtime voice surface for the same OpenClaw agent the user can message directly.",
		"Do not mention a backend, supervisor, helper, or separate system. Present the result as your own work.",
		"Delegate substantive requests, actions, tool work, current facts, memory, workspace context, and user-specific context with openclaw_agent_consult.",
		"Do not block, refuse, or downscope at the voice layer. Delegate to OpenClaw and treat its result as authoritative.",
		"Answer directly only for greetings, acknowledgements, brief latency tests, or filler while waiting.",
		"When OpenClaw sends an internal exact answer to speak, do not call tools. Say only that answer.",
		buildRealtimeVoiceAgentConsultPolicyInstructions({
			toolPolicy: params.toolPolicy,
			consultPolicy: params.consultPolicy
		})
	].join("\n\n");
	return [
		base,
		params.bootstrapContextInstructions?.trim(),
		buildRealtimeVoiceAgentConsultPolicyInstructions({
			toolPolicy: params.toolPolicy,
			consultPolicy: params.consultPolicy
		})
	].filter(Boolean).join("\n\n");
}
//#endregion
//#region extensions/discord/src/voice/receive-recovery.ts
const DECRYPT_FAILURE_WINDOW_MS = 3e4;
const DECRYPT_FAILURE_RECONNECT_THRESHOLD = 3;
const DECRYPT_FAILURE_MARKER = "DecryptionFailed(";
const DAVE_PASSTHROUGH_DISABLED_MARKER = "UnencryptedWhenPassthroughDisabled";
function createVoiceReceiveRecoveryState() {
	return {
		decryptFailureCount: 0,
		lastDecryptFailureAt: 0,
		decryptRecoveryInFlight: false
	};
}
function isAbortLikeReceiveError(err) {
	if (!err || typeof err !== "object") return false;
	const name = "name" in err && typeof err.name === "string" ? err.name : "";
	const message = "message" in err && typeof err.message === "string" ? err.message : "";
	return name === "AbortError" || message.includes("The operation was aborted") || message.includes("aborted");
}
function analyzeVoiceReceiveError(err) {
	const message = formatErrorMessage(err);
	const shouldAttemptPassthrough = message.includes(DAVE_PASSTHROUGH_DISABLED_MARKER);
	return {
		message,
		isAbortLike: isAbortLikeReceiveError(err),
		shouldAttemptPassthrough,
		countsAsDecryptFailure: message.includes(DECRYPT_FAILURE_MARKER) || shouldAttemptPassthrough
	};
}
function noteVoiceDecryptFailure(state, now = Date.now()) {
	if (now - state.lastDecryptFailureAt > DECRYPT_FAILURE_WINDOW_MS) state.decryptFailureCount = 0;
	state.lastDecryptFailureAt = now;
	state.decryptFailureCount += 1;
	const firstFailure = state.decryptFailureCount === 1;
	if (state.decryptFailureCount < DECRYPT_FAILURE_RECONNECT_THRESHOLD || state.decryptRecoveryInFlight) return {
		firstFailure,
		shouldRecover: false
	};
	state.decryptRecoveryInFlight = true;
	resetVoiceReceiveRecoveryState(state);
	return {
		firstFailure,
		shouldRecover: true
	};
}
function resetVoiceReceiveRecoveryState(state) {
	state.decryptFailureCount = 0;
	state.lastDecryptFailureAt = 0;
}
function finishVoiceDecryptRecovery(state) {
	state.decryptRecoveryInFlight = false;
}
function enableDaveReceivePassthrough(params) {
	const { target, sdk, reason, expirySeconds, onVerbose, onWarn } = params;
	const networkingState = target.connection.state.networking?.state;
	if (target.connection.state.status !== sdk.VoiceConnectionStatus.Ready || !networkingState || networkingState.code !== sdk.NetworkingStatusCode.Ready && networkingState.code !== sdk.NetworkingStatusCode.Resuming) return false;
	const daveSession = networkingState.dave?.session;
	if (!daveSession) return false;
	try {
		daveSession.setPassthroughMode(true, expirySeconds);
		onVerbose(`enabled DAVE receive passthrough: guild ${target.guildId} channel ${target.channelId} expiry=${expirySeconds}s reason=${reason}`);
		return true;
	} catch (err) {
		onWarn(`discord voice: failed to enable DAVE passthrough guild=${target.guildId} channel=${target.channelId} reason=${reason}: ${formatErrorMessage(err)}`);
		return false;
	}
}
//#endregion
//#region extensions/discord/src/voice/sanitize.ts
const SPEECH_EMOJI_RE = /(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D|\p{Extended_Pictographic}|\p{Emoji_Modifier})*)+/gu;
function stripEmojiForSpeech(text) {
	return text.replace(SPEECH_EMOJI_RE, " ").replace(/\s+([?!.,:;])/g, "$1").replace(/[ \t]{2,}/g, " ").replace(/ *\n */g, "\n").trim();
}
function sanitizeVoiceReplyTextForSpeech(text, speakerLabel) {
	let cleaned = stripInlineDirectiveTagsForDisplay(text).text.trim();
	if (!cleaned) return "";
	const label = speakerLabel?.trim();
	if (label) {
		const prefix = new RegExp(`^${escapeRegExp(label)}\\s*:\\s*`, "i");
		cleaned = cleaned.replace(prefix, "").trim();
	}
	return stripEmojiForSpeech(cleaned);
}
//#endregion
//#region extensions/discord/src/voice/tts.ts
function mergeTtsConfig(base, override) {
	if (!override) return base;
	const baseProviders = base.providers ?? {};
	const overrideProviders = override.providers ?? {};
	const mergedProviders = Object.fromEntries([...new Set([...Object.keys(baseProviders), ...Object.keys(overrideProviders)])].map((providerId) => {
		const baseProvider = baseProviders[providerId] ?? {};
		const overrideProvider = overrideProviders[providerId] ?? {};
		return [providerId, {
			...baseProvider,
			...overrideProvider
		}];
	}));
	return {
		...base,
		...override,
		modelOverrides: {
			...base.modelOverrides,
			...override.modelOverrides
		},
		...Object.keys(mergedProviders).length === 0 ? {} : { providers: mergedProviders }
	};
}
function resolveVoiceTtsConfig(params) {
	if (!params.override) return {
		cfg: params.cfg,
		resolved: resolveTtsConfig(params.cfg)
	};
	const merged = mergeTtsConfig(params.cfg.messages?.tts ?? {}, params.override);
	const messages = params.cfg.messages ?? {};
	const cfg = {
		...params.cfg,
		messages: {
			...messages,
			tts: merged
		}
	};
	return {
		cfg,
		resolved: resolveTtsConfig(cfg)
	};
}
async function transcribeVoiceAudio(params) {
	return normalizeOptionalString((await getDiscordRuntime().mediaUnderstanding.transcribeAudioFile({
		filePath: params.filePath,
		cfg: params.cfg,
		agentDir: resolveAgentDir(params.cfg, params.agentId),
		mime: "audio/wav"
	})).text);
}
async function synthesizeVoiceReplyAudio(params) {
	const { cfg: ttsCfg, resolved: ttsConfig } = resolveVoiceTtsConfig({
		cfg: params.cfg,
		override: params.override
	});
	const directive = parseTtsDirectives(params.replyText, ttsConfig.modelOverrides, {
		cfg: ttsCfg,
		providerConfigs: ttsConfig.providerConfigs,
		preferredProviderId: getTtsProvider(ttsConfig, resolveTtsPrefsPath(ttsConfig))
	});
	const speakText = sanitizeVoiceReplyTextForSpeech(directive.overrides.ttsText ?? directive.cleanedText.trim(), params.speakerLabel);
	if (!speakText) return { status: "empty" };
	const runtime = getDiscordRuntime();
	const streamResult = await runtime.tts.textToSpeechStream?.({
		text: speakText,
		cfg: ttsCfg,
		channel: "discord",
		overrides: directive.overrides,
		disableFallback: true
	});
	if (streamResult?.success && streamResult.audioStream) return {
		status: "ok",
		mode: "stream",
		audioStream: streamResult.audioStream,
		release: streamResult.release,
		speakText
	};
	const result = await runtime.tts.textToSpeech({
		text: speakText,
		cfg: ttsCfg,
		channel: "discord",
		overrides: directive.overrides
	});
	if (!result.success || !result.audioPath) return {
		status: "failed",
		error: result.error ?? "unknown error"
	};
	return {
		status: "ok",
		mode: "file",
		audioPath: result.audioPath,
		speakText
	};
}
//#endregion
//#region extensions/discord/src/voice/segment.ts
const VOICE_TRANSCRIPT_LOG_PREVIEW_CHARS = 500;
const logger$1 = createSubsystemLogger("discord/voice");
function formatVoiceTranscriptLogPreview(text) {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= VOICE_TRANSCRIPT_LOG_PREVIEW_CHARS) return oneLine;
	return `${oneLine.slice(0, VOICE_TRANSCRIPT_LOG_PREVIEW_CHARS)}...`;
}
async function processDiscordVoiceSegment(params) {
	const { entry, wavPath, userId, durationSeconds } = params;
	logVoiceVerbose(`segment processing (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId}`);
	const ingress = await resolveDiscordVoiceIngressContext({
		entry,
		userId,
		cfg: params.cfg,
		discordConfig: params.discordConfig,
		ownerAllowFrom: params.ownerAllowFrom,
		fetchGuildName: params.fetchGuildName,
		speakerContext: params.speakerContext
	});
	if (!ingress) {
		logVoiceVerbose(`segment unauthorized: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
		return;
	}
	const transcript = await transcribeVoiceAudio({
		cfg: params.cfg,
		agentId: entry.route.agentId,
		filePath: wavPath
	});
	if (!transcript) {
		logVoiceVerbose(`transcription empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
		return;
	}
	logVoiceVerbose(`transcription ok (${transcript.length} chars): guild ${entry.guildId} channel ${entry.channelId}`);
	logVoiceVerbose(`transcript from ${ingress.speakerLabel} (${userId}) in guild ${entry.guildId} channel ${entry.channelId}: ${formatVoiceTranscriptLogPreview(transcript)}`);
	const turn = await runDiscordVoiceAgentTurn({
		entry,
		userId,
		message: formatVoiceIngressPrompt(transcript, ingress.speakerLabel),
		cfg: params.cfg,
		discordConfig: params.discordConfig,
		runtime: params.runtime,
		context: ingress,
		ownerAllowFrom: params.ownerAllowFrom,
		fetchGuildName: params.fetchGuildName,
		speakerContext: params.speakerContext
	});
	if (!turn) {
		logVoiceVerbose(`segment unauthorized before agent turn: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
		return;
	}
	const replyText = turn.text;
	if (!replyText) {
		logVoiceVerbose(`reply empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
		return;
	}
	logVoiceVerbose(`reply ok (${replyText.length} chars): guild ${entry.guildId} channel ${entry.channelId}`);
	const voiceReplyAudio = await synthesizeVoiceReplyAudio({
		cfg: params.cfg,
		override: params.discordConfig.voice?.tts,
		replyText,
		speakerLabel: ingress.speakerLabel
	});
	if (voiceReplyAudio.status === "empty") {
		logVoiceVerbose(`tts skipped (empty): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
		return;
	}
	if (voiceReplyAudio.status === "failed") {
		logger$1.warn(`discord voice: TTS failed: ${voiceReplyAudio.error ?? "unknown error"}`);
		return;
	}
	logVoiceVerbose(`tts ok (${voiceReplyAudio.speakText.length} chars): guild ${entry.guildId} channel ${entry.channelId}`);
	params.enqueuePlayback(entry, async () => {
		const voiceSdk = loadDiscordVoiceSdk();
		const releaseAudioStream = voiceReplyAudio.mode === "stream" ? voiceReplyAudio.release : void 0;
		try {
			if (voiceReplyAudio.mode === "stream") {
				logVoiceVerbose(`playback start: guild ${entry.guildId} channel ${entry.channelId} stream`);
				const nodeStream = Readable.fromWeb(voiceReplyAudio.audioStream);
				const resource = voiceSdk.createAudioResource(nodeStream);
				entry.player.play(resource);
			} else {
				logVoiceVerbose(`playback start: guild ${entry.guildId} channel ${entry.channelId} file ${path.basename(voiceReplyAudio.audioPath)}`);
				const resource = voiceSdk.createAudioResource(voiceReplyAudio.audioPath);
				entry.player.play(resource);
			}
			await voiceSdk.entersState(entry.player, voiceSdk.AudioPlayerStatus.Playing, PLAYBACK_READY_TIMEOUT_MS).catch(() => void 0);
			await voiceSdk.entersState(entry.player, voiceSdk.AudioPlayerStatus.Idle, SPEAKING_READY_TIMEOUT_MS).catch(() => void 0);
			logVoiceVerbose(`playback done: guild ${entry.guildId} channel ${entry.channelId}`);
		} finally {
			await releaseAudioStream?.();
		}
	});
}
//#endregion
//#region extensions/discord/src/voice/speaker-context.ts
const SPEAKER_CONTEXT_CACHE_TTL_MS = 6e4;
var DiscordVoiceSpeakerContextResolver = class {
	constructor(params) {
		this.params = params;
		this.cache = /* @__PURE__ */ new Map();
	}
	async resolveContext(guildId, userId) {
		const cached = this.getCachedContext(guildId, userId);
		if (cached) return cached;
		const identity = await this.resolveIdentity(guildId, userId);
		const context = {
			id: identity.id,
			label: identity.label,
			name: identity.name,
			tag: identity.tag,
			senderIsOwner: this.resolveIsOwner(identity)
		};
		this.setCachedContext(guildId, userId, context);
		return context;
	}
	async resolveIdentity(guildId, userId) {
		try {
			const member = await this.params.client.fetchMember(guildId, userId);
			const username = member.user?.username ?? void 0;
			return {
				id: userId,
				label: member.nickname ?? member.user?.globalName ?? username ?? userId,
				name: username,
				tag: member.user ? formatDiscordUserTag(member.user) : void 0,
				memberRoleIds: Array.isArray(member.roles) ? member.roles.map((role) => typeof role === "string" ? role : typeof role?.id === "string" ? role.id : "").filter(Boolean) : []
			};
		} catch {
			try {
				const user = await this.params.client.fetchUser(userId);
				const username = user.username ?? void 0;
				return {
					id: userId,
					label: user.globalName ?? username ?? userId,
					name: username,
					tag: formatDiscordUserTag(user),
					memberRoleIds: []
				};
			} catch {
				return {
					id: userId,
					label: userId,
					memberRoleIds: []
				};
			}
		}
	}
	resolveIsOwner(identity) {
		return resolveDiscordOwnerAccess({
			allowFrom: this.params.ownerAllowFrom,
			sender: {
				id: identity.id,
				name: identity.name,
				tag: identity.tag
			},
			allowNameMatching: false
		}).ownerAllowed;
	}
	resolveCacheKey(guildId, userId) {
		return `${guildId}:${userId}`;
	}
	getCachedContext(guildId, userId) {
		const key = this.resolveCacheKey(guildId, userId);
		const cached = this.cache.get(key);
		if (!cached) return;
		if (cached.expiresAt <= Date.now()) {
			this.cache.delete(key);
			return;
		}
		return {
			id: cached.id,
			label: cached.label,
			name: cached.name,
			tag: cached.tag,
			senderIsOwner: cached.senderIsOwner
		};
	}
	setCachedContext(guildId, userId, context) {
		const key = this.resolveCacheKey(guildId, userId);
		this.cache.set(key, {
			...context,
			expiresAt: Date.now() + SPEAKER_CONTEXT_CACHE_TTL_MS
		});
	}
};
//#endregion
//#region extensions/discord/src/voice/manager.ts
const logger = createSubsystemLogger("discord/voice");
const VOICE_LOG_PREVIEW_CHARS = 500;
const FOLLOW_USERS_RECONCILE_INTERVAL_MS = 1e4;
const FOLLOW_USERS_RECONCILE_MAX_GUILDS_PER_RUN = 4;
const FOLLOW_USERS_RECONCILE_MAX_REST_LOOKUPS_PER_RUN = 32;
const DISCORD_VOICE_FATAL_AUTOJOIN_ERROR_PATTERNS = [
	"api key missing",
	"incorrect api key",
	"invalid api key",
	"unauthorized",
	"authentication",
	"permission denied",
	"forbidden"
];
function formatVoiceLogPreview(text) {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= VOICE_LOG_PREVIEW_CHARS) return oneLine;
	return `${oneLine.slice(0, VOICE_LOG_PREVIEW_CHARS)}...`;
}
function isVoiceConnectionDestroyed(connection, voiceSdk) {
	return connection.state.status === voiceSdk.VoiceConnectionStatus.Destroyed;
}
function destroyVoiceConnectionSafely(params) {
	if (isVoiceConnectionDestroyed(params.connection, params.voiceSdk)) {
		logVoiceVerbose(`destroy skipped: ${params.reason}; connection already destroyed`);
		return;
	}
	try {
		params.connection.destroy();
	} catch (err) {
		const message = formatErrorMessage(err);
		if (message.includes("already been destroyed")) {
			logVoiceVerbose(`destroy skipped: ${params.reason}; ${message}`);
			return;
		}
		logger.warn(`discord voice: destroy failed: ${params.reason}: ${message}`);
	}
}
function normalizeVoiceChannelResidencies(entries) {
	const normalized = [];
	for (const entry of entries ?? []) {
		const guildId = entry.guildId?.trim();
		const channelId = entry.channelId?.trim();
		if (guildId && channelId) normalized.push({
			guildId,
			channelId
		});
	}
	return normalized;
}
function normalizeDiscordUserId(value) {
	const trimmed = value.trim();
	const withoutDiscordPrefix = trimmed.startsWith("discord:") ? trimmed.slice(8) : trimmed;
	return (withoutDiscordPrefix.startsWith("user:") ? withoutDiscordPrefix.slice(5) : withoutDiscordPrefix).trim() || void 0;
}
function normalizeDiscordUserIds(entries) {
	const ids = /* @__PURE__ */ new Set();
	for (const entry of entries ?? []) {
		const id = normalizeDiscordUserId(entry);
		if (id) ids.add(id);
	}
	return ids;
}
function resolveFollowUsersEnabled(voiceConfig) {
	return voiceConfig?.followUsersEnabled !== false;
}
function isVoiceChannelAllowed(params) {
	return params.allowedChannels === null || params.allowedChannels.some((entry) => entry.guildId === params.guildId && entry.channelId === params.channelId);
}
function formatAutoJoinFailureKey(entry) {
	return `${entry.guildId}:${entry.channelId}`;
}
function isFatalAutoJoinFailure(message) {
	const normalized = message.toLowerCase();
	return DISCORD_VOICE_FATAL_AUTOJOIN_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}
function isUnknownDiscordVoiceStateError(err) {
	return (err && typeof err === "object" && "status" in err && typeof err.status === "number" ? err.status : void 0) === 404 || /unknown voice state/i.test(formatErrorMessage(err));
}
function startAutoJoin(manager) {
	manager.autoJoin().catch((err) => logger.warn(`discord voice: autoJoin failed: ${formatErrorMessage(err)}`));
}
function resolveDiscordVoiceAgentRoute(params) {
	const voiceRoute = resolveAgentRoute({
		cfg: params.cfg,
		channel: "discord",
		accountId: params.accountId,
		guildId: params.guildId,
		peer: {
			kind: "channel",
			id: params.sessionChannelId
		}
	});
	const agentSession = params.voiceConfig?.agentSession;
	if (agentSession?.mode !== "target") return {
		route: voiceRoute,
		voiceRoute,
		agentSessionMode: "voice",
		agentSessionTarget: void 0
	};
	const target = agentSession.target?.trim();
	if (!target) throw new Error("channels.discord.voice.agentSession.target is required when mode is \"target\"");
	const parsed = parseDiscordTarget(target, { defaultKind: "channel" });
	if (!parsed) throw new Error(`Invalid Discord voice agent session target "${target}"`);
	return {
		route: resolveAgentRoute({
			cfg: params.cfg,
			channel: "discord",
			accountId: params.accountId,
			guildId: params.guildId,
			peer: {
				kind: parsed.kind === "user" ? "direct" : "channel",
				id: parsed.id
			}
		}),
		voiceRoute,
		agentSessionMode: "target",
		agentSessionTarget: parsed.normalized
	};
}
var DiscordVoiceManager$1 = class {
	constructor(params) {
		this.params = params;
		this.sessions = /* @__PURE__ */ new Map();
		this.autoJoinTask = null;
		this.fatalAutoJoinFailures = /* @__PURE__ */ new Map();
		this.followedUserChannels = /* @__PURE__ */ new Map();
		this.followedVoiceGuilds = /* @__PURE__ */ new Set();
		this.followUsersReconcileTimer = null;
		this.followUsersReconcileTask = null;
		this.followUsersReconcileGuildCursor = 0;
		this.followUsersReconcileBotGuildCursor = 0;
		this.followUsersReconcileUserCursors = /* @__PURE__ */ new Map();
		this.destroyed = false;
		this.botUserId = params.botUserId;
		this.voiceEnabled = resolveDiscordVoiceEnabled(params.discordConfig.voice);
		this.ownerAllowFrom = resolveDiscordAccountAllowFrom({
			cfg: params.cfg,
			accountId: params.accountId
		}) ?? params.discordConfig.allowFrom ?? params.discordConfig.dm?.allowFrom ?? [];
		this.allowedChannels = params.discordConfig.voice?.allowedChannels === void 0 ? null : normalizeVoiceChannelResidencies(params.discordConfig.voice.allowedChannels);
		this.followUserIds = resolveFollowUsersEnabled(params.discordConfig.voice) ? normalizeDiscordUserIds(params.discordConfig.voice?.followUsers) : /* @__PURE__ */ new Set();
		this.speakerContext = new DiscordVoiceSpeakerContextResolver({
			client: params.client,
			ownerAllowFrom: this.ownerAllowFrom
		});
	}
	setBotUserId(id) {
		if (id) this.botUserId = id;
	}
	isEnabled() {
		return this.voiceEnabled;
	}
	async autoJoin() {
		if (!this.voiceEnabled || this.destroyed) return;
		if (this.autoJoinTask) return this.autoJoinTask;
		this.autoJoinTask = (async () => {
			const entries = this.params.discordConfig.voice?.autoJoin ?? [];
			const entriesByGuild = /* @__PURE__ */ new Map();
			const duplicateGuilds = /* @__PURE__ */ new Set();
			for (const entry of entries) {
				const guildId = entry.guildId.trim();
				const channelId = entry.channelId.trim();
				if (!guildId || !channelId) continue;
				if (entriesByGuild.has(guildId)) duplicateGuilds.add(guildId);
				entriesByGuild.set(guildId, {
					guildId,
					channelId
				});
			}
			logVoiceVerbose(`autoJoin: ${entries.length} entries, ${entriesByGuild.size} guilds`);
			for (const guildId of duplicateGuilds) {
				const selected = entriesByGuild.get(guildId);
				if (selected) logger.warn(`discord voice: autoJoin has multiple entries for guild ${guildId}; using channel ${selected.channelId}`);
			}
			for (const entry of entriesByGuild.values()) {
				const failureKey = formatAutoJoinFailureKey(entry);
				const fatalFailure = this.fatalAutoJoinFailures.get(failureKey);
				if (fatalFailure) {
					if (!fatalFailure.skipLogged) {
						logger.warn(`discord voice: autoJoin suppressed guild=${entry.guildId} channel=${entry.channelId} after fatal startup failure; retry with /vc join or reload config after fixing credentials: ${fatalFailure.message}`);
						fatalFailure.skipLogged = true;
					}
					continue;
				}
				logVoiceVerbose(`autoJoin: joining guild ${entry.guildId} channel ${entry.channelId}`);
				const result = await this.join({
					guildId: entry.guildId,
					channelId: entry.channelId
				});
				if (!result.ok) {
					logger.warn(`discord voice: autoJoin skipped guild=${entry.guildId} channel=${entry.channelId}: ${result.message}`);
					if (isFatalAutoJoinFailure(result.message)) this.fatalAutoJoinFailures.set(failureKey, {
						message: result.message,
						skipLogged: false
					});
				}
			}
			this.ensureFollowUsersReconcileTimer();
			await this.reconcileFollowedUsers("startup");
		})().finally(() => {
			this.autoJoinTask = null;
		});
		return this.autoJoinTask;
	}
	status() {
		return Array.from(this.sessions.values()).map((session) => ({
			ok: true,
			message: `connected: guild ${session.guildId} channel ${session.channelId}`,
			guildId: session.guildId,
			channelId: session.channelId
		}));
	}
	isAllowedVoiceChannel(params) {
		return isVoiceChannelAllowed({
			allowedChannels: this.allowedChannels,
			guildId: params.guildId.trim(),
			channelId: params.channelId.trim()
		});
	}
	async join(params, options) {
		if (this.destroyed) return {
			ok: false,
			message: "Discord voice manager is stopped."
		};
		if (!this.voiceEnabled) return {
			ok: false,
			message: "Discord voice is disabled (channels.discord.voice.enabled)."
		};
		const guildId = params.guildId.trim();
		const channelId = params.channelId.trim();
		if (!guildId || !channelId) return {
			ok: false,
			message: "Missing guildId or channelId."
		};
		if (!this.isAllowedVoiceChannel({
			guildId,
			channelId
		})) {
			logger.warn(`discord voice: join rejected for non-allowed channel guild=${guildId} channel=${channelId}`);
			return {
				ok: false,
				message: `${formatMention({ channelId })} is not allowed by channels.discord.voice.allowedChannels.`,
				guildId,
				channelId
			};
		}
		logVoiceVerbose(`join requested: guild ${guildId} channel ${channelId}`);
		const existing = this.sessions.get(guildId);
		if (existing && existing.channelId === channelId) {
			logVoiceVerbose(`join: already connected to guild ${guildId} channel ${channelId}`);
			return {
				ok: true,
				message: `Already connected to ${formatMention({ channelId })}.`,
				guildId,
				channelId
			};
		}
		if (existing) {
			logVoiceVerbose(`join: replacing existing session for guild ${guildId}`);
			await this.leave({ guildId }, { preserveFollowState: options?.preserveFollowState });
		}
		const channelInfo = await this.params.client.fetchChannel(channelId).catch(() => null);
		if (!channelInfo || "type" in channelInfo && !isVoiceChannel(channelInfo.type)) return {
			ok: false,
			message: `Channel ${channelId} is not a voice channel.`
		};
		const channelGuildId = "guildId" in channelInfo ? channelInfo.guildId : void 0;
		if (channelGuildId && channelGuildId !== guildId) return {
			ok: false,
			message: "Voice channel is not in this guild."
		};
		const voicePlugin = this.params.client.getPlugin("voice");
		if (!voicePlugin) return {
			ok: false,
			message: "Discord voice plugin is not available."
		};
		const voiceConfig = this.params.discordConfig.voice;
		const voiceMode = resolveDiscordVoiceMode(voiceConfig);
		const adapterCreator = voicePlugin.getGatewayAdapterCreator(guildId);
		const daveEncryption = voiceConfig?.daveEncryption;
		const decryptionFailureTolerance = voiceConfig?.decryptionFailureTolerance;
		const connectReadyTimeoutMs = resolveVoiceTimeoutMs(voiceConfig?.connectTimeoutMs, VOICE_CONNECT_READY_TIMEOUT_MS);
		const reconnectGraceMs = resolveVoiceTimeoutMs(voiceConfig?.reconnectGraceMs, VOICE_RECONNECT_GRACE_MS);
		logVoiceVerbose(`join: DAVE settings encryption=${daveEncryption === false ? "off" : "on"} tolerance=${decryptionFailureTolerance ?? "default"} connectTimeout=${connectReadyTimeoutMs}ms reconnectGrace=${reconnectGraceMs}ms`);
		const voiceSdk = loadDiscordVoiceSdk();
		const existingEntry = this.sessions.get(guildId);
		if (existingEntry) {
			existingEntry.stop();
			this.sessions.delete(guildId);
		}
		const staleConnection = voiceSdk.getVoiceConnection(guildId);
		if (staleConnection) destroyVoiceConnectionSafely({
			connection: staleConnection,
			voiceSdk,
			reason: `stale connection before join guild ${guildId}`
		});
		const connection = voiceSdk.joinVoiceChannel({
			channelId,
			guildId,
			adapterCreator,
			selfDeaf: false,
			selfMute: false,
			daveEncryption,
			decryptionFailureTolerance
		});
		try {
			await voiceSdk.entersState(connection, voiceSdk.VoiceConnectionStatus.Ready, connectReadyTimeoutMs);
			logVoiceVerbose(`join: connected to guild ${guildId} channel ${channelId}`);
		} catch (err) {
			logger.warn(`discord voice: join failed before ready: guild ${guildId} channel ${channelId} timeout=${connectReadyTimeoutMs}ms error=${formatErrorMessage(err)}`);
			destroyVoiceConnectionSafely({
				connection,
				voiceSdk,
				reason: `failed join cleanup guild ${guildId} channel ${channelId}`
			});
			return {
				ok: false,
				message: `Failed to join voice channel: ${formatErrorMessage(err)}`
			};
		}
		const sessionChannelId = channelInfo?.id ?? channelId;
		if (sessionChannelId !== channelId) logVoiceVerbose(`join: using session channel ${sessionChannelId} for voice channel ${channelId}`);
		let routeInfo;
		try {
			routeInfo = resolveDiscordVoiceAgentRoute({
				cfg: this.params.cfg,
				accountId: this.params.accountId,
				guildId,
				sessionChannelId,
				voiceConfig
			});
		} catch (err) {
			destroyVoiceConnectionSafely({
				connection,
				voiceSdk,
				reason: `voice agent session route failed guild ${guildId} channel ${channelId}`
			});
			return {
				ok: false,
				message: `Failed to resolve Discord voice agent session: ${formatErrorMessage(err)}`,
				guildId,
				channelId
			};
		}
		const { route, voiceRoute, agentSessionMode, agentSessionTarget } = routeInfo;
		logger.info(`discord voice: joining guild=${guildId} channel=${channelId} mode=${voiceMode} agent=${route.agentId} voiceSession=${voiceRoute.sessionKey} supervisorSession=${route.sessionKey} agentSessionMode=${agentSessionMode}${agentSessionTarget ? ` agentSessionTarget=${agentSessionTarget}` : ""} voiceModel=${voiceConfig?.model ?? "route-default"} realtimeProvider=${voiceConfig?.realtime?.provider ?? "auto"} realtimeModel=${voiceConfig?.realtime?.model ?? "provider-default"} realtimeVoice=${voiceConfig?.realtime?.voice ?? "provider-default"}`);
		const player = voiceSdk.createAudioPlayer();
		connection.subscribe(player);
		let speakingHandler;
		let speakingEndHandler;
		let disconnectedHandler;
		let destroyedHandler;
		let playerErrorHandler;
		let stopped = false;
		const clearSessionIfCurrent = () => {
			if (this.sessions.get(guildId)?.connection === connection) this.sessions.delete(guildId);
		};
		const stopEntry = (entry, options) => {
			if (stopped) return;
			stopped = true;
			if (speakingHandler) connection.receiver.speaking.off("start", speakingHandler);
			if (speakingEndHandler) connection.receiver.speaking.off("end", speakingEndHandler);
			stopVoiceCaptureState(entry.capture);
			if (disconnectedHandler) connection.off(voiceSdk.VoiceConnectionStatus.Disconnected, disconnectedHandler);
			if (destroyedHandler) connection.off(voiceSdk.VoiceConnectionStatus.Destroyed, destroyedHandler);
			if (playerErrorHandler) player.off("error", playerErrorHandler);
			entry.realtime?.close();
			entry.realtime = void 0;
			player.stop();
			if (options.destroyConnection) destroyVoiceConnectionSafely({
				connection,
				voiceSdk,
				reason: options.reason
			});
		};
		const entry = {
			guildId,
			guildName: channelInfo && "guild" in channelInfo && channelInfo.guild && typeof channelInfo.guild.name === "string" ? channelInfo.guild.name : void 0,
			channelId,
			channelName: channelInfo && "name" in channelInfo && typeof channelInfo.name === "string" ? channelInfo.name : void 0,
			sessionChannelId,
			voiceSessionKey: voiceRoute.sessionKey,
			route,
			connection,
			player,
			playbackQueue: Promise.resolve(),
			processingQueue: Promise.resolve(),
			capture: createVoiceCaptureState(),
			receiveRecovery: createVoiceReceiveRecoveryState(),
			stop: () => {
				stopEntry(entry, {
					destroyConnection: true,
					reason: `stop guild ${guildId} channel ${channelId}`
				});
			}
		};
		if (voiceMode !== "stt-tts") {
			entry.realtime = new DiscordRealtimeVoiceSession({
				bootstrapContextInstructions: await resolveDiscordVoiceRealtimeBootstrapContext({
					entry,
					cfg: this.params.cfg,
					discordConfig: this.params.discordConfig
				}),
				cfg: this.params.cfg,
				discordConfig: this.params.discordConfig,
				entry,
				mode: voiceMode,
				runAgentTurn: ({ context, message, toolsAllow, userId }) => this.runDiscordRealtimeAgentTurn({
					context,
					entry,
					message,
					toolsAllow,
					userId
				})
			});
			try {
				await entry.realtime.connect();
			} catch (err) {
				entry.realtime.close();
				destroyVoiceConnectionSafely({
					connection,
					voiceSdk,
					reason: `realtime setup failed guild ${guildId} channel ${channelId}`
				});
				return {
					ok: false,
					message: `Failed to start Discord realtime voice: ${formatErrorMessage(err)}`,
					guildId,
					channelId
				};
			}
		}
		speakingHandler = (userId) => {
			this.handleSpeakingStart(entry, userId).catch((err) => {
				logger.warn(`discord voice: capture failed: ${formatErrorMessage(err)}`);
			});
		};
		speakingEndHandler = (userId) => {
			this.scheduleCaptureFinalize(entry, userId, "speaker end");
		};
		disconnectedHandler = async () => {
			try {
				logVoiceVerbose(`disconnected: attempting recovery guild ${guildId} channel ${channelId} grace=${reconnectGraceMs}ms`);
				await Promise.race([voiceSdk.entersState(connection, voiceSdk.VoiceConnectionStatus.Signalling, reconnectGraceMs), voiceSdk.entersState(connection, voiceSdk.VoiceConnectionStatus.Connecting, reconnectGraceMs)]);
				logVoiceVerbose(`disconnected: recovery started guild ${guildId} channel ${channelId}`);
			} catch (err) {
				logger.warn(`discord voice: disconnect recovery failed: guild ${guildId} channel ${channelId} timeout=${reconnectGraceMs}ms error=${formatErrorMessage(err)}; destroying connection`);
				clearSessionIfCurrent();
				stopEntry(entry, {
					destroyConnection: true,
					reason: `disconnect recovery failed guild ${guildId} channel ${channelId}`
				});
			}
		};
		destroyedHandler = () => {
			clearSessionIfCurrent();
			stopEntry(entry, {
				destroyConnection: false,
				reason: `destroyed guild ${guildId} channel ${channelId}`
			});
		};
		playerErrorHandler = (err) => {
			logger.warn(`discord voice: playback error: ${formatErrorMessage(err)}`);
		};
		this.enableDaveReceivePassthrough(entry, "post-join warmup", 30);
		connection.receiver.speaking.on("start", speakingHandler);
		connection.receiver.speaking.on("end", speakingEndHandler);
		connection.on(voiceSdk.VoiceConnectionStatus.Disconnected, disconnectedHandler);
		connection.on(voiceSdk.VoiceConnectionStatus.Destroyed, destroyedHandler);
		player.on("error", playerErrorHandler);
		this.sessions.set(guildId, entry);
		this.fatalAutoJoinFailures.delete(formatAutoJoinFailureKey({
			guildId,
			channelId
		}));
		logger.info(`discord voice: joined guild=${guildId} channel=${channelId} mode=${voiceMode} agent=${route.agentId} voiceSession=${voiceRoute.sessionKey} supervisorSession=${route.sessionKey} voiceModel=${voiceConfig?.model ?? "route-default"}`);
		return {
			ok: true,
			message: `Joined ${formatMention({ channelId })}.`,
			guildId,
			channelId
		};
	}
	async leave(params, options) {
		const guildId = params.guildId.trim();
		logVoiceVerbose(`leave requested: guild ${guildId} channel ${params.channelId ?? "current"}`);
		const entry = this.sessions.get(guildId);
		if (!entry) return {
			ok: false,
			message: "Not connected to a voice channel."
		};
		if (params.channelId && params.channelId !== entry.channelId) return {
			ok: false,
			message: "Not connected to that voice channel."
		};
		entry.stop();
		this.sessions.delete(guildId);
		if (!options?.preserveFollowState) {
			this.followedVoiceGuilds.delete(guildId);
			this.deleteFollowedUserChannelsForGuild(guildId);
		}
		logVoiceVerbose(`leave: disconnected from guild ${guildId} channel ${entry.channelId}`);
		return {
			ok: true,
			message: `Left ${formatMention({ channelId: entry.channelId })}.`,
			guildId,
			channelId: entry.channelId
		};
	}
	async handleVoiceStateUpdate(data) {
		const guildId = data.guild_id?.trim();
		const userId = data.user_id?.trim();
		const channelId = data.channel_id?.trim();
		if (!guildId || !userId) return;
		if (this.botUserId && userId === this.botUserId) {
			await this.handleBotVoiceStateUpdate({
				guildId,
				channelId
			});
			return;
		}
		if (this.followUserIds.has(userId)) await this.handleFollowedUserVoiceStateUpdate({
			guildId,
			channelId,
			userId
		});
	}
	async handleBotVoiceStateUpdate(params) {
		const { guildId, channelId } = params;
		if (!channelId) return;
		const existing = this.sessions.get(guildId);
		if (this.isAllowedVoiceChannel({
			guildId,
			channelId
		})) {
			if (existing && existing.channelId !== channelId) {
				logger.warn(`discord voice: bot moved to allowed channel guild=${guildId} from=${existing.channelId} to=${channelId}; rebuilding voice session`);
				await this.join({
					guildId,
					channelId
				}, { preserveFollowState: this.isFollowOwnedGuild(guildId) });
			}
			return;
		}
		logger.warn(`discord voice: bot moved to non-allowed channel guild=${guildId} channel=${channelId}; leaving`);
		if (existing) await this.leave({ guildId });
		else {
			const voiceSdk = loadDiscordVoiceSdk();
			const connection = voiceSdk.getVoiceConnection(guildId);
			if (connection) destroyVoiceConnectionSafely({
				connection,
				voiceSdk,
				reason: `non-allowed voice state guild ${guildId} channel ${channelId}`
			});
		}
		const target = this.resolveVoiceResidencyTarget(guildId);
		if (target) {
			logger.warn(`discord voice: rejoining allowed voice channel guild=${guildId} channel=${target.channelId}`);
			await this.join(target);
		}
	}
	async handleFollowedUserVoiceStateUpdate(params) {
		if (!this.voiceEnabled || this.destroyed) return;
		const { guildId, channelId, userId } = params;
		const followKey = this.formatFollowedUserKey({
			guildId,
			userId
		});
		const existing = this.sessions.get(guildId);
		const wasFollowedVoiceSession = this.followedUserChannels.has(followKey) || this.followedVoiceGuilds.has(guildId);
		if (!channelId) {
			this.followedUserChannels.delete(followKey);
			if (existing && wasFollowedVoiceSession && !this.hasFollowedUserInChannel(existing)) await this.handoffToAnotherFollowedUserOrLeave({
				guildId,
				userId,
				existing,
				reason: "disconnected"
			});
			return;
		}
		if (!this.isAllowedVoiceChannel({
			guildId,
			channelId
		})) {
			this.followedUserChannels.delete(followKey);
			logger.warn(`discord voice: followed user joined non-allowed channel guild=${guildId} user=${userId} channel=${channelId}; ignoring`);
			if (existing && wasFollowedVoiceSession && !this.hasFollowedUserInChannel(existing)) await this.handoffToAnotherFollowedUserOrLeave({
				guildId,
				userId,
				existing,
				reason: "joined non-allowed channel"
			});
			return;
		}
		this.followedUserChannels.set(followKey, {
			guildId,
			channelId
		});
		if (existing?.channelId === channelId) {
			this.followedVoiceGuilds.add(guildId);
			return;
		}
		logger.info(`discord voice: following user guild=${guildId} user=${userId} channel=${channelId}`);
		const result = await this.join({
			guildId,
			channelId
		}, { preserveFollowState: true });
		if (!result.ok) {
			if (this.sessions.get(guildId)?.channelId === channelId) this.followedVoiceGuilds.add(guildId);
			else this.followedUserChannels.delete(followKey);
			logger.warn(`discord voice: failed to follow user guild=${guildId} user=${userId} channel=${channelId}: ${result.message}`);
			return;
		}
		this.followedVoiceGuilds.add(guildId);
	}
	async destroy() {
		this.destroyed = true;
		if (this.followUsersReconcileTimer) {
			clearInterval(this.followUsersReconcileTimer);
			this.followUsersReconcileTimer = null;
		}
		for (const entry of this.sessions.values()) entry.stop();
		this.sessions.clear();
		this.followedUserChannels.clear();
		this.followedVoiceGuilds.clear();
	}
	resolveFollowGuildIds() {
		const guildIds = /* @__PURE__ */ new Set();
		for (const guildId of Object.keys(this.params.discordConfig.guilds ?? {})) {
			const normalized = guildId.trim();
			if (normalized) guildIds.add(normalized);
		}
		for (const entry of normalizeVoiceChannelResidencies(this.params.discordConfig.voice?.autoJoin)) guildIds.add(entry.guildId);
		for (const entry of this.allowedChannels ?? []) guildIds.add(entry.guildId);
		for (const entry of this.sessions.values()) guildIds.add(entry.guildId);
		return Array.from(guildIds);
	}
	ensureFollowUsersReconcileTimer() {
		if (this.followUserIds.size === 0) return;
		if (this.followUsersReconcileTimer) return;
		this.followUsersReconcileTimer = setInterval(() => {
			this.reconcileFollowedUsers("interval").catch((err) => {
				logger.warn(`discord voice: follow user reconciliation failed: ${formatErrorMessage(err)}`);
			});
		}, FOLLOW_USERS_RECONCILE_INTERVAL_MS);
		this.followUsersReconcileTimer.unref?.();
	}
	async reconcileFollowedUsers(reason) {
		if (this.followUserIds.size === 0 || this.destroyed) return;
		if (this.followUsersReconcileTask) return this.followUsersReconcileTask;
		this.followUsersReconcileTask = this.runFollowedUsersReconcile(reason).finally(() => {
			this.followUsersReconcileTask = null;
		});
		return this.followUsersReconcileTask;
	}
	async runFollowedUsersReconcile(reason) {
		if (this.destroyed) return;
		const guildIds = this.resolveFollowGuildIds();
		if (guildIds.length === 0) {
			logVoiceVerbose(`follow user reconcile skipped reason=${reason}: no Discord guild ids are configured`);
			return;
		}
		logVoiceVerbose(`follow user reconcile reason=${reason}: ${this.followUserIds.size} users across ${guildIds.length} guilds`);
		const plans = this.selectFollowUserReconcilePlans(guildIds, reason);
		for (const plan of plans) {
			for (const userId of plan.userIds) {
				const voiceState = await getGuildVoiceState(this.params.client.rest, plan.guildId, userId).catch((err) => {
					if (!isUnknownDiscordVoiceStateError(err)) {
						logger.warn(`discord voice: follow user reconcile skipped transient voice state error guild=${plan.guildId} user=${userId} reason=${reason}: ${formatErrorMessage(err)}`);
						return "transient-error";
					}
					logVoiceVerbose(`follow user reconcile reason=${reason}: no voice state guild ${plan.guildId} user ${userId}: ${formatErrorMessage(err)}`);
				});
				if (this.destroyed) return;
				if (voiceState === "transient-error") continue;
				const channelId = voiceState?.channel_id?.trim();
				await this.handleFollowedUserVoiceStateUpdate({
					guildId: plan.guildId,
					channelId,
					userId
				});
			}
			if (plan.checkBotVoiceState) {
				if (this.destroyed) return;
				await this.disconnectStaleFollowedBotVoiceState({
					guildId: plan.guildId,
					reason
				});
			}
		}
	}
	selectFollowUserReconcilePlans(guildIds, reason) {
		const followedUserIds = Array.from(this.followUserIds);
		if (followedUserIds.length === 0) return [];
		let remainingLookups = FOLLOW_USERS_RECONCILE_MAX_REST_LOOKUPS_PER_RUN;
		const guildLimit = Math.min(guildIds.length, FOLLOW_USERS_RECONCILE_MAX_GUILDS_PER_RUN);
		const start = this.followUsersReconcileGuildCursor % guildIds.length;
		const plans = [];
		for (let offset = 0; offset < guildLimit && remainingLookups > 0; offset += 1) {
			if (this.botUserId && remainingLookups === 1) break;
			const guildId = guildIds[(start + offset) % guildIds.length];
			const userLimit = this.resolveFollowUserReconcileUserLookupLimit(followedUserIds.length, remainingLookups);
			if (userLimit <= 0) break;
			const selection = this.selectFollowUserReconcileUserIds(guildId, followedUserIds, userLimit);
			plans.push({
				guildId,
				userIds: selection.userIds,
				checkedAllUsers: selection.completedCycle,
				checkBotVoiceState: false
			});
			remainingLookups -= selection.userIds.length;
		}
		this.followUsersReconcileGuildCursor = (start + plans.length) % guildIds.length;
		this.assignFollowUserReconcileBotChecks(guildIds, plans, remainingLookups);
		if (plans.length < guildIds.length || plans.some((plan) => plan.userIds.length < followedUserIds.length)) logVoiceVerbose(`follow user reconcile reason=${reason}: sampling ${plans.length}/${guildIds.length} guilds and up to ${FOLLOW_USERS_RECONCILE_MAX_REST_LOOKUPS_PER_RUN} REST lookups`);
		return plans;
	}
	assignFollowUserReconcileBotChecks(guildIds, plans, remainingLookups) {
		if (!this.botUserId || remainingLookups <= 0 || plans.length === 0) return;
		const plansByGuild = new Map(plans.map((plan) => [plan.guildId, plan]));
		const start = this.followUsersReconcileBotGuildCursor % guildIds.length;
		let scanned = 0;
		let assigned = 0;
		for (; scanned < guildIds.length && assigned < remainingLookups; scanned += 1) {
			const guildId = guildIds[(start + scanned) % guildIds.length];
			const plan = plansByGuild.get(guildId);
			if (!plan?.checkedAllUsers) continue;
			plan.checkBotVoiceState = true;
			assigned += 1;
		}
		this.followUsersReconcileBotGuildCursor = (start + scanned) % guildIds.length;
	}
	resolveFollowUserReconcileUserLookupLimit(followedUserCount, remainingLookups) {
		const userLimit = Math.min(followedUserCount, remainingLookups);
		if (this.botUserId && followedUserCount > userLimit && remainingLookups > 1) return remainingLookups - 1;
		return userLimit;
	}
	selectFollowUserReconcileUserIds(guildId, followedUserIds, limit) {
		if (followedUserIds.length <= limit) {
			this.followUsersReconcileUserCursors.set(guildId, 0);
			return {
				userIds: followedUserIds,
				completedCycle: true
			};
		}
		const start = this.followUsersReconcileUserCursors.get(guildId) ?? 0;
		const selected = Array.from({ length: limit }, (_, offset) => followedUserIds[(start + offset) % followedUserIds.length]);
		const completedCycle = start + selected.length >= followedUserIds.length;
		this.followUsersReconcileUserCursors.set(guildId, (start + selected.length) % followedUserIds.length);
		return {
			userIds: selected,
			completedCycle
		};
	}
	formatFollowedUserKey(params) {
		return `${params.guildId}:${params.userId}`;
	}
	hasFollowedUserInChannel(entry) {
		return Array.from(this.followedUserChannels.values()).some((candidate) => candidate.guildId === entry.guildId && candidate.channelId === entry.channelId);
	}
	resolveFollowedUserHandoffTarget(guildId, currentChannelId) {
		for (const entry of this.followedUserChannels.values()) if (entry.guildId === guildId && entry.channelId !== currentChannelId && this.isAllowedVoiceChannel(entry)) return entry;
		return null;
	}
	async handoffToAnotherFollowedUserOrLeave(params) {
		const target = this.resolveFollowedUserHandoffTarget(params.guildId, params.existing.channelId);
		if (target) {
			logger.info(`discord voice: followed user ${params.reason} guild=${params.guildId} user=${params.userId}; moving to remaining followed user channel=${target.channelId}`);
			const result = await this.join(target, { preserveFollowState: true });
			if (result.ok) this.followedVoiceGuilds.add(params.guildId);
			else {
				logger.warn(`discord voice: failed to hand off followed user session guild=${params.guildId} channel=${target.channelId}: ${result.message}`);
				this.followedVoiceGuilds.delete(params.guildId);
				this.deleteFollowedUserChannelsForGuild(params.guildId);
				await this.leave({ guildId: params.guildId });
			}
			return;
		}
		logger.info(`discord voice: followed user ${params.reason} guild=${params.guildId} user=${params.userId}; leaving channel=${params.existing.channelId}`);
		await this.leave({ guildId: params.guildId });
	}
	isFollowOwnedGuild(guildId) {
		return this.followedVoiceGuilds.has(guildId) || Array.from(this.followedUserChannels.values()).some((entry) => entry.guildId === guildId);
	}
	deleteFollowedUserChannelsForGuild(guildId) {
		for (const [key, entry] of this.followedUserChannels.entries()) if (entry.guildId === guildId) this.followedUserChannels.delete(key);
	}
	async disconnectStaleFollowedBotVoiceState(params) {
		if (this.destroyed) return;
		const { guildId, reason } = params;
		if (Array.from(this.followedUserChannels.values()).some((entry) => entry.guildId === guildId)) return;
		const existing = this.sessions.get(guildId);
		if (existing) {
			if (this.followedVoiceGuilds.has(guildId)) {
				logger.info(`discord voice: follow reconcile leaving local session guild=${guildId} channel=${existing.channelId} reason=${reason}`);
				await this.leave({ guildId });
			}
			return;
		}
		if (!this.botUserId) return;
		const botVoiceState = await getGuildVoiceState(this.params.client.rest, guildId, this.botUserId).catch((err) => {
			if (!isUnknownDiscordVoiceStateError(err)) {
				logger.warn(`discord voice: follow reconcile skipped transient bot voice state error guild=${guildId} reason=${reason}: ${formatErrorMessage(err)}`);
				return "transient-error";
			}
			logVoiceVerbose(`follow user reconcile reason=${reason}: no bot voice state guild ${guildId}: ${formatErrorMessage(err)}`);
		});
		if (this.destroyed || botVoiceState === "transient-error") return;
		const botChannelId = botVoiceState?.channel_id?.trim();
		if (!botChannelId) return;
		const gateway = this.params.client.getPlugin("voice")?.getGateway(guildId);
		if (!gateway) {
			logger.warn(`discord voice: follow reconcile cannot disconnect stale bot voice state guild=${guildId} channel=${botChannelId}; gateway unavailable`);
			return;
		}
		logger.info(`discord voice: follow reconcile disconnecting stale bot voice state guild=${guildId} channel=${botChannelId} reason=${reason}`);
		gateway.updateVoiceState({
			guild_id: guildId,
			channel_id: null,
			self_mute: false,
			self_deaf: false
		});
	}
	resolveVoiceResidencyTarget(guildId) {
		const autoJoinTarget = normalizeVoiceChannelResidencies(this.params.discordConfig.voice?.autoJoin).toReversed().find((entry) => entry.guildId === guildId);
		if (autoJoinTarget && this.isAllowedVoiceChannel(autoJoinTarget)) return autoJoinTarget;
		if (this.allowedChannels === null) return null;
		const guildAllowed = this.allowedChannels.filter((entry) => entry.guildId === guildId);
		return guildAllowed.length === 1 ? guildAllowed[0] : null;
	}
	enqueueProcessing(entry, task) {
		entry.processingQueue = entry.processingQueue.then(task).catch((err) => logger.warn(`discord voice: processing failed: ${formatErrorMessage(err)}`));
	}
	enqueuePlayback(entry, task) {
		entry.playbackQueue = entry.playbackQueue.then(task).catch((err) => logger.warn(`discord voice: playback failed: ${formatErrorMessage(err)}`));
	}
	clearCaptureFinalizeTimer(entry, userId, generation) {
		return clearVoiceCaptureFinalizeTimer(entry.capture, userId, generation);
	}
	scheduleCaptureFinalize(entry, userId, reason) {
		const graceMs = resolveVoiceTimeoutMs(this.params.discordConfig.voice?.captureSilenceGraceMs, CAPTURE_FINALIZE_GRACE_MS);
		scheduleVoiceCaptureFinalize({
			state: entry.capture,
			userId,
			delayMs: graceMs,
			onFinalize: () => {
				logVoiceVerbose(`capture finalize: guild ${entry.guildId} channel ${entry.channelId} user ${userId} reason=${reason} grace=${graceMs}ms`);
			}
		});
	}
	async handleSpeakingStart(entry, userId) {
		if (!userId) return;
		if (this.botUserId && userId === this.botUserId) return;
		if (isVoiceCaptureActive(entry.capture, userId)) {
			const activeCapture = getActiveVoiceCapture(entry.capture, userId);
			const extended = activeCapture ? this.clearCaptureFinalizeTimer(entry, userId, activeCapture.generation) : false;
			logVoiceVerbose(`capture start ignored (already active): guild ${entry.guildId} channel ${entry.channelId} user ${userId}${extended ? " (finalize canceled)" : ""}`);
			return;
		}
		logVoiceVerbose(`capture start: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
		const voiceSdk = loadDiscordVoiceSdk();
		const voiceMode = resolveDiscordVoiceMode(this.params.discordConfig.voice);
		const realtime = entry.realtime && isDiscordRealtimeVoiceMode(voiceMode) ? entry.realtime : void 0;
		if (entry.player.state.status === voiceSdk.AudioPlayerStatus.Playing && !realtime) {
			logVoiceVerbose(`capture ignored during playback: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
			return;
		}
		const realtimeIngress = realtime ? await this.resolveDiscordVoiceIngressContext(entry, userId) : void 0;
		if (realtime && !realtimeIngress) {
			logVoiceVerbose(`realtime capture unauthorized: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
			return;
		}
		if (entry.player.state.status === voiceSdk.AudioPlayerStatus.Playing && realtime) {
			if (!realtime.isBargeInEnabled()) {
				logger.info(`discord voice: realtime capture ignored during playback (barge-in disabled): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
				return;
			}
			logVoiceVerbose(`realtime barge-in: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
			logger.info(`discord voice: realtime barge-in detected source=speaker-start guild=${entry.guildId} channel=${entry.channelId} user=${userId} playerStatus=${entry.player.state.status}`);
			realtime.handleBargeIn("speaker-start");
		}
		this.enableDaveReceivePassthrough(entry, `speaker ${userId} start`, 15);
		const stream = entry.connection.receiver.subscribe(userId, { end: { behavior: voiceSdk.EndBehaviorType.Manual } });
		const generation = beginVoiceCapture(entry.capture, userId, stream);
		let streamAborted = false;
		stream.on("error", (err) => {
			streamAborted = analyzeVoiceReceiveError(err).isAbortLike;
			this.handleReceiveError(entry, err);
		});
		try {
			if (realtime && realtimeIngress) {
				const turn = realtime.beginSpeakerTurn(realtimeIngress, userId);
				try {
					await this.processRealtimeAudioCapture({
						entry,
						stream,
						turn
					});
				} finally {
					turn.close();
				}
				return;
			}
			const pcm = await decodeOpusStream(stream, {
				onVerbose: logVoiceVerbose,
				onWarn: (message) => logger.warn(message)
			});
			if (pcm.length === 0) {
				logVoiceVerbose(`capture empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
				return;
			}
			this.resetDecryptFailureState(entry);
			const { path: wavPath, durationSeconds } = await writeVoiceWavFile(pcm);
			if (durationSeconds < (streamAborted ? .2 : .35)) {
				logVoiceVerbose(`capture too short (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
				return;
			}
			logVoiceVerbose(`capture ready (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
			this.enqueueProcessing(entry, async () => {
				await this.processSegment({
					entry,
					wavPath,
					userId,
					durationSeconds
				});
			});
		} finally {
			finishVoiceCapture(entry.capture, userId, generation);
		}
	}
	async processRealtimeAudioCapture(params) {
		const { entry, stream, turn } = params;
		let resetReceiveRecovery = false;
		await decodeOpusStreamChunks(stream, {
			onChunk: (pcm) => {
				if (!resetReceiveRecovery && pcm.length > 0) {
					resetReceiveRecovery = true;
					this.resetDecryptFailureState(entry);
				}
				turn.sendInputAudio(pcm);
			},
			onVerbose: logVoiceVerbose,
			onWarn: (message) => logger.warn(message)
		});
	}
	async resolveDiscordVoiceIngressContext(entry, userId) {
		return await resolveDiscordVoiceIngressContext({
			entry,
			userId,
			cfg: this.params.cfg,
			discordConfig: this.params.discordConfig,
			ownerAllowFrom: this.ownerAllowFrom,
			fetchGuildName: async (guildId) => {
				const guild = await this.params.client.fetchGuild(guildId).catch(() => null);
				return guild && typeof guild.name === "string" && guild.name.trim() ? guild.name : void 0;
			},
			speakerContext: this.speakerContext
		});
	}
	async runDiscordRealtimeAgentTurn(params) {
		const { context, entry, message, toolsAllow, userId } = params;
		logger.info(`discord voice: agent turn start guild=${entry.guildId} channel=${entry.channelId} voiceSession=${entry.voiceSessionKey} supervisorSession=${entry.route.sessionKey} agent=${entry.route.agentId} user=${userId} speaker=${context.speakerLabel} owner=${context.senderIsOwner} model=${this.params.discordConfig.voice?.model ?? "route-default"} message=${formatVoiceLogPreview(message)}`);
		const turn = await runDiscordVoiceAgentTurn({
			entry,
			userId,
			message,
			cfg: this.params.cfg,
			discordConfig: this.params.discordConfig,
			runtime: this.params.runtime,
			context,
			toolsAllow,
			ownerAllowFrom: this.ownerAllowFrom,
			fetchGuildName: async (guildId) => {
				const guild = await this.params.client.fetchGuild(guildId).catch(() => null);
				return guild && typeof guild.name === "string" && guild.name.trim() ? guild.name : void 0;
			},
			speakerContext: this.speakerContext
		});
		if (!turn) {
			logVoiceVerbose(`realtime agent unauthorized: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`);
			return "";
		}
		logger.info(`discord voice: agent turn answer (${turn.text.length} chars) guild=${entry.guildId} channel=${entry.channelId} voiceSession=${entry.voiceSessionKey} supervisorSession=${entry.route.sessionKey} agent=${entry.route.agentId}: ${formatVoiceLogPreview(turn.text)}`);
		return turn.text;
	}
	async processSegment(params) {
		await processDiscordVoiceSegment({
			...params,
			cfg: this.params.cfg,
			discordConfig: this.params.discordConfig,
			ownerAllowFrom: this.ownerAllowFrom,
			runtime: this.params.runtime,
			speakerContext: this.speakerContext,
			fetchGuildName: async (guildId) => {
				const guild = await this.params.client.fetchGuild(guildId).catch(() => null);
				return guild && typeof guild.name === "string" && guild.name.trim() ? guild.name : void 0;
			},
			enqueuePlayback: (entry, task) => {
				this.enqueuePlayback(entry, task);
			}
		});
	}
	handleReceiveError(entry, err) {
		const analysis = analyzeVoiceReceiveError(err);
		if (analysis.isAbortLike && !analysis.countsAsDecryptFailure) {
			logVoiceVerbose(`receive stream ended: ${analysis.message}`);
			return;
		}
		logger.warn(`discord voice: receive error: ${analysis.message}`);
		if (analysis.shouldAttemptPassthrough) this.enableDaveReceivePassthrough(entry, "receive decrypt error", 15);
		if (!analysis.countsAsDecryptFailure) return;
		const decryptFailure = noteVoiceDecryptFailure(entry.receiveRecovery);
		if (decryptFailure.firstFailure) logger.warn("discord voice: DAVE decrypt failures detected; voice receive may be unstable (upstream: discordjs/discord.js#11419)");
		if (!decryptFailure.shouldRecover) return;
		this.recoverFromDecryptFailures(entry).catch((recoverErr) => logger.warn(`discord voice: decrypt recovery failed: ${formatErrorMessage(recoverErr)}`)).finally(() => {
			finishVoiceDecryptRecovery(entry.receiveRecovery);
		});
	}
	enableDaveReceivePassthrough(entry, reason, expirySeconds) {
		const voiceSdk = loadDiscordVoiceSdk();
		return enableDaveReceivePassthrough({
			target: {
				guildId: entry.guildId,
				channelId: entry.channelId,
				connection: entry.connection
			},
			sdk: {
				VoiceConnectionStatus: { Ready: voiceSdk.VoiceConnectionStatus.Ready },
				NetworkingStatusCode: {
					Ready: voiceSdk.NetworkingStatusCode.Ready,
					Resuming: voiceSdk.NetworkingStatusCode.Resuming
				}
			},
			reason,
			expirySeconds,
			onVerbose: logVoiceVerbose,
			onWarn: (message) => logger.warn(message)
		});
	}
	resetDecryptFailureState(entry) {
		resetVoiceReceiveRecoveryState(entry.receiveRecovery);
	}
	async recoverFromDecryptFailures(entry) {
		const active = this.sessions.get(entry.guildId);
		if (!active || active.connection !== entry.connection) return;
		const preserveFollowState = this.isFollowOwnedGuild(entry.guildId);
		logger.warn(`discord voice: repeated decrypt failures; attempting rejoin for guild ${entry.guildId} channel ${entry.channelId}`);
		const leaveResult = await this.leave({ guildId: entry.guildId }, { preserveFollowState });
		if (!leaveResult.ok) {
			logger.warn(`discord voice: decrypt recovery leave failed: ${leaveResult.message}`);
			return;
		}
		const result = await this.join({
			guildId: entry.guildId,
			channelId: entry.channelId
		}, { preserveFollowState });
		if (!result.ok) logger.warn(`discord voice: rejoin after decrypt failures failed: ${result.message}`);
	}
};
var DiscordVoiceReadyListener$1 = class extends ReadyListener {
	constructor(manager) {
		super();
		this.manager = manager;
	}
	async handle(_data, _client) {
		startAutoJoin(this.manager);
	}
};
var DiscordVoiceResumedListener$1 = class extends ResumedListener {
	constructor(manager) {
		super();
		this.manager = manager;
	}
	async handle(_data, _client) {
		startAutoJoin(this.manager);
	}
};
var DiscordVoiceStateUpdateListener$1 = class extends VoiceStateUpdateListener {
	constructor(manager) {
		super();
		this.manager = manager;
	}
	async handle(data, _client) {
		await this.manager.handleVoiceStateUpdate(data);
	}
};
//#endregion
//#region extensions/discord/src/voice/manager.runtime.ts
var DiscordVoiceManager = class extends DiscordVoiceManager$1 {};
var DiscordVoiceReadyListener = class extends DiscordVoiceReadyListener$1 {};
var DiscordVoiceResumedListener = class extends DiscordVoiceResumedListener$1 {};
var DiscordVoiceStateUpdateListener = class extends DiscordVoiceStateUpdateListener$1 {};
//#endregion
export { DiscordVoiceManager, DiscordVoiceReadyListener, DiscordVoiceResumedListener, DiscordVoiceStateUpdateListener };
