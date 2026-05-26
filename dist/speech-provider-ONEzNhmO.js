import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { u as normalizeResolvedSecretInputString } from "./types.secrets-DwPik3M8.js";
import { g as transcodeAudioBufferToOpus } from "./media-services-CLFjOJQs.js";
import { l as sanitizeConfiguredModelProviderRequest } from "./provider-request-config-DxK6PUHR.js";
import { i as assertOkOrThrowProviderError, n as asObject } from "./provider-http-errors-C90BH-le.js";
import { c as postJsonRequest } from "./shared-D8kCtbT2.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./secret-input-CWnTb0tw.js";
import "./media-runtime-BheBFFxc.js";
import "./speech-core-DVjAqDEd.js";
import "./provider-http-CYBE-CBM.js";
import { t as resolveGoogleGenerativeAiHttpRequestConfig } from "./api-B6GzhKwj.js";
//#region extensions/google/speech-provider.ts
const DEFAULT_GOOGLE_TTS_MODEL = "gemini-3.1-flash-tts-preview";
const DEFAULT_GOOGLE_TTS_VOICE = "Kore";
const GOOGLE_TTS_SAMPLE_RATE = 24e3;
const GOOGLE_TTS_CHANNELS = 1;
const GOOGLE_TTS_BITS_PER_SAMPLE = 16;
const GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE = "audio-profile-v1";
const GOOGLE_TTS_MODELS = [
	"gemini-3.1-flash-tts-preview",
	"gemini-2.5-flash-preview-tts",
	"gemini-2.5-pro-preview-tts"
];
const GOOGLE_TTS_VOICES = [
	"Zephyr",
	"Puck",
	"Charon",
	"Kore",
	"Fenrir",
	"Leda",
	"Orus",
	"Aoede",
	"Callirrhoe",
	"Autonoe",
	"Enceladus",
	"Iapetus",
	"Umbriel",
	"Algieba",
	"Despina",
	"Erinome",
	"Algenib",
	"Rasalgethi",
	"Laomedeia",
	"Achernar",
	"Alnilam",
	"Schedar",
	"Gacrux",
	"Pulcherrima",
	"Achird",
	"Zubenelgenubi",
	"Vindemiatrix",
	"Sadachbia",
	"Sadaltager",
	"Sulafat"
];
var GoogleTtsRetryableError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "GoogleTtsRetryableError";
	}
};
function isGoogleTtsRetryableError(err) {
	if (err instanceof GoogleTtsRetryableError) return true;
	if (!(err instanceof Error)) return false;
	if (err.name === "AbortError") return true;
	const message = err.message.toLowerCase();
	return message.includes("aborted") || message.includes("timeout") || message.includes("fetch failed") || message.includes("network");
}
function normalizeGoogleTtsModel(model) {
	const trimmed = normalizeOptionalString(model);
	if (!trimmed) return DEFAULT_GOOGLE_TTS_MODEL;
	const withoutProvider = trimmed.startsWith("google/") ? trimmed.slice(7) : trimmed;
	return withoutProvider === "gemini-3.1-flash-tts" ? DEFAULT_GOOGLE_TTS_MODEL : withoutProvider;
}
function normalizeGoogleTtsVoiceName(voiceName) {
	return normalizeOptionalString(voiceName) ?? DEFAULT_GOOGLE_TTS_VOICE;
}
function normalizeGooglePromptTemplate(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return;
	if (trimmed === GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE) return trimmed;
	throw new Error(`Invalid Google TTS promptTemplate: ${trimmed}`);
}
function resolveGoogleTtsEnvApiKey() {
	return normalizeOptionalString(process.env.GEMINI_API_KEY) ?? normalizeOptionalString(process.env.GOOGLE_API_KEY);
}
function resolveGoogleTtsModelProviderApiKey(cfg) {
	return normalizeResolvedSecretInputString({
		value: cfg?.models?.providers?.google?.apiKey,
		path: "models.providers.google.apiKey"
	});
}
function resolveGoogleTtsApiKey(params) {
	return readGoogleTtsProviderConfig(params.providerConfig).apiKey ?? resolveGoogleTtsModelProviderApiKey(params.cfg) ?? resolveGoogleTtsEnvApiKey();
}
function resolveGoogleTtsBaseUrl(params) {
	return params.providerConfig.baseUrl ?? normalizeOptionalString(params.cfg?.models?.providers?.google?.baseUrl);
}
function resolveGoogleTtsConfigRecord(rawConfig) {
	return asObject(asObject(rawConfig.providers)?.google) ?? asObject(rawConfig.google);
}
function normalizeGoogleTtsProviderConfig(rawConfig) {
	const raw = resolveGoogleTtsConfigRecord(rawConfig);
	const promptTemplate = normalizeGooglePromptTemplate(raw?.promptTemplate);
	const personaPrompt = normalizeOptionalString(raw?.personaPrompt);
	return {
		apiKey: normalizeResolvedSecretInputString({
			value: raw?.apiKey,
			path: "messages.tts.providers.google.apiKey"
		}),
		baseUrl: normalizeOptionalString(raw?.baseUrl),
		model: normalizeGoogleTtsModel(raw?.model),
		voiceName: normalizeGoogleTtsVoiceName(raw?.voiceName ?? raw?.voice),
		audioProfile: normalizeOptionalString(raw?.audioProfile),
		speakerName: normalizeOptionalString(raw?.speakerName),
		...promptTemplate ? { promptTemplate } : {},
		...personaPrompt ? { personaPrompt } : {}
	};
}
function readGoogleTtsProviderConfig(config) {
	const normalized = normalizeGoogleTtsProviderConfig({});
	const promptTemplate = normalizeGooglePromptTemplate(config.promptTemplate) ?? normalized.promptTemplate;
	const personaPrompt = normalizeOptionalString(config.personaPrompt) ?? normalized.personaPrompt;
	return {
		apiKey: normalizeOptionalString(config.apiKey) ?? normalized.apiKey,
		baseUrl: normalizeOptionalString(config.baseUrl) ?? normalized.baseUrl,
		model: normalizeGoogleTtsModel(config.model ?? normalized.model),
		voiceName: normalizeGoogleTtsVoiceName(config.voiceName ?? config.voice ?? normalized.voiceName),
		audioProfile: normalizeOptionalString(config.audioProfile) ?? normalized.audioProfile,
		speakerName: normalizeOptionalString(config.speakerName) ?? normalized.speakerName,
		...promptTemplate ? { promptTemplate } : {},
		...personaPrompt ? { personaPrompt } : {}
	};
}
function readGoogleTtsOverrides(overrides) {
	if (!overrides) return {};
	return {
		model: normalizeOptionalString(overrides.model),
		voiceName: normalizeOptionalString(overrides.voiceName ?? overrides.voice),
		audioProfile: normalizeOptionalString(overrides.audioProfile),
		speakerName: normalizeOptionalString(overrides.speakerName)
	};
}
function composeGoogleTtsText(params) {
	return [
		normalizeOptionalString(params.audioProfile),
		normalizeOptionalString(params.speakerName) ? `Speaker name: ${params.speakerName}` : void 0,
		params.text
	].filter((part) => part !== void 0).join("\n\n");
}
function parseDirectiveToken(ctx) {
	switch (ctx.key) {
		case "voicename":
		case "voice_name":
		case "google_voice":
		case "googlevoice":
			if (!ctx.policy.allowVoice) return { handled: true };
			return {
				handled: true,
				overrides: { voiceName: ctx.value }
			};
		case "google_model":
		case "googlemodel":
			if (!ctx.policy.allowModelId) return { handled: true };
			return {
				handled: true,
				overrides: { model: ctx.value }
			};
		default: return { handled: false };
	}
}
function extractGoogleSpeechPcm(payload) {
	for (const candidate of payload.candidates ?? []) for (const part of candidate.content?.parts ?? []) {
		const data = normalizeOptionalString((part.inlineData ?? part.inline_data)?.data);
		if (!data) continue;
		return Buffer.from(data, "base64");
	}
	throw new Error("Google TTS response missing audio data");
}
function normalizePromptSectionText(value) {
	const trimmed = normalizeOptionalString(value?.replace(/\r\n?/g, "\n"));
	if (!trimmed) return;
	let sanitized = "";
	for (const char of trimmed) {
		const code = char.charCodeAt(0);
		if (code >= 0 && code <= 8 || code === 11 || code === 12 || code >= 14 && code <= 31 || code === 127) continue;
		sanitized += char;
	}
	return sanitized;
}
function normalizePromptList(values) {
	return (values ?? []).map((value) => normalizePromptSectionText(value)).filter((value) => Boolean(value));
}
function isOpenClawGoogleAudioProfilePrompt(text) {
	return text.includes("# AUDIO PROFILE:") && text.includes("### TRANSCRIPT") && text.startsWith("Synthesize speech from the TRANSCRIPT section only.");
}
function renderGoogleAudioProfilePrompt(params) {
	const transcript = params.text.replace(/\r\n?/g, "\n").trim();
	const prompt = params.persona?.prompt;
	const profile = normalizePromptSectionText(prompt?.profile);
	const scene = normalizePromptSectionText(prompt?.scene);
	const sampleContext = normalizePromptSectionText(prompt?.sampleContext);
	const style = normalizePromptSectionText(prompt?.style);
	const accent = normalizePromptSectionText(prompt?.accent);
	const pacing = normalizePromptSectionText(prompt?.pacing);
	const constraints = normalizePromptList(prompt?.constraints);
	const personaPrompt = normalizePromptSectionText(params.personaPrompt);
	const label = normalizePromptSectionText(params.persona?.label) ?? normalizePromptSectionText(params.persona?.id);
	const sections = [[
		"Synthesize speech from the TRANSCRIPT section only. Use the other sections only",
		"as performance direction. Do not read section titles, notes, labels, or",
		"configuration aloud."
	].join("\n")];
	if (label || profile) sections.push([`# AUDIO PROFILE: ${label ?? "voice"}`, profile].filter(Boolean).join("\n"));
	if (scene) sections.push(["## THE SCENE", scene].join("\n"));
	const directorNotes = [];
	if (style) directorNotes.push(`Style: ${style}`);
	if (accent) directorNotes.push(`Accent: ${accent}`);
	if (pacing) directorNotes.push(`Pacing: ${pacing}`);
	if (constraints.length > 0) directorNotes.push(["Constraints:", ...constraints.map((item) => `- ${item}`)].join("\n"));
	if (personaPrompt) directorNotes.push(["Provider notes:", personaPrompt].join("\n"));
	if (directorNotes.length > 0) sections.push(["### DIRECTOR'S NOTES", ...directorNotes].join("\n"));
	if (sampleContext) sections.push(["### SAMPLE CONTEXT", sampleContext].join("\n"));
	sections.push(["### TRANSCRIPT", transcript].join("\n"));
	return sections.join("\n\n");
}
function wrapPcm16MonoToWav(pcm, sampleRate = GOOGLE_TTS_SAMPLE_RATE) {
	const byteRate = sampleRate * GOOGLE_TTS_CHANNELS * (GOOGLE_TTS_BITS_PER_SAMPLE / 8);
	const blockAlign = GOOGLE_TTS_CHANNELS * (GOOGLE_TTS_BITS_PER_SAMPLE / 8);
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(GOOGLE_TTS_CHANNELS, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(blockAlign, 32);
	header.writeUInt16LE(GOOGLE_TTS_BITS_PER_SAMPLE, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}
async function synthesizeGoogleTtsPcmOnce(params) {
	const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveGoogleGenerativeAiHttpRequestConfig({
		apiKey: params.apiKey,
		baseUrl: params.baseUrl,
		request: params.request,
		capability: "audio",
		transport: "http"
	});
	const { response: res, release } = await postJsonRequest({
		url: `${baseUrl}/models/${params.model}:generateContent`,
		headers,
		body: {
			contents: [{
				role: "user",
				parts: [{ text: composeGoogleTtsText({
					text: params.text,
					audioProfile: params.audioProfile,
					speakerName: params.speakerName
				}) }]
			}],
			generationConfig: {
				responseModalities: ["AUDIO"],
				speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: params.voiceName } } }
			}
		},
		timeoutMs: params.timeoutMs,
		fetchFn: fetch,
		pinDns: false,
		allowPrivateNetwork,
		dispatcherPolicy
	});
	try {
		if (!res.ok) try {
			await assertOkOrThrowProviderError(res, "Google TTS failed");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (res.status >= 500 && res.status < 600) throw new GoogleTtsRetryableError(message);
			throw err;
		}
		try {
			return extractGoogleSpeechPcm(await res.json());
		} catch (err) {
			throw new GoogleTtsRetryableError(err instanceof Error ? err.message : String(err));
		}
	} finally {
		await release();
	}
}
async function synthesizeGoogleTtsPcm(params) {
	let lastError;
	for (let attempt = 0; attempt < 2; attempt += 1) try {
		return await synthesizeGoogleTtsPcmOnce(params);
	} catch (err) {
		lastError = err;
		if (!isGoogleTtsRetryableError(err) || attempt > 0) throw err;
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
function buildGoogleSpeechProvider() {
	return {
		id: "google",
		label: "Google",
		autoSelectOrder: 50,
		models: GOOGLE_TTS_MODELS,
		voices: GOOGLE_TTS_VOICES,
		resolveConfig: ({ rawConfig }) => normalizeGoogleTtsProviderConfig(rawConfig),
		parseDirectiveToken,
		resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
			return {
				...normalizeGoogleTtsProviderConfig(baseTtsConfig),
				...talkProviderConfig.apiKey === void 0 ? {} : { apiKey: normalizeResolvedSecretInputString({
					value: talkProviderConfig.apiKey,
					path: "talk.providers.google.apiKey"
				}) },
				...normalizeOptionalString(talkProviderConfig.baseUrl) == null ? {} : { baseUrl: normalizeOptionalString(talkProviderConfig.baseUrl) },
				...normalizeOptionalString(talkProviderConfig.modelId) == null ? {} : { model: normalizeGoogleTtsModel(talkProviderConfig.modelId) },
				...normalizeOptionalString(talkProviderConfig.voiceId) == null ? {} : { voiceName: normalizeGoogleTtsVoiceName(talkProviderConfig.voiceId) }
			};
		},
		resolveTalkOverrides: ({ params }) => ({
			...normalizeOptionalString(params.voiceId) == null ? {} : { voiceName: normalizeGoogleTtsVoiceName(params.voiceId) },
			...normalizeOptionalString(params.modelId) == null ? {} : { model: normalizeGoogleTtsModel(params.modelId) }
		}),
		listVoices: async () => GOOGLE_TTS_VOICES.map((voice) => ({
			id: voice,
			name: voice
		})),
		isConfigured: ({ cfg, providerConfig }) => Boolean(resolveGoogleTtsApiKey({
			cfg,
			providerConfig
		})),
		prepareSynthesis: (ctx) => {
			const config = readGoogleTtsProviderConfig(ctx.providerConfig);
			if (!(config.promptTemplate === GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE || Boolean(config.personaPrompt)) || isOpenClawGoogleAudioProfilePrompt(ctx.text)) return;
			return { text: renderGoogleAudioProfilePrompt({
				text: ctx.text,
				persona: ctx.persona,
				personaPrompt: config.personaPrompt
			}) };
		},
		synthesize: async (req) => {
			const config = readGoogleTtsProviderConfig(req.providerConfig);
			const overrides = readGoogleTtsOverrides(req.providerOverrides);
			const apiKey = resolveGoogleTtsApiKey({
				cfg: req.cfg,
				providerConfig: req.providerConfig
			});
			if (!apiKey) throw new Error("Google API key missing");
			const pcm = await synthesizeGoogleTtsPcm({
				text: req.text,
				apiKey,
				baseUrl: resolveGoogleTtsBaseUrl({
					cfg: req.cfg,
					providerConfig: config
				}),
				request: sanitizeConfiguredModelProviderRequest(req.cfg?.models?.providers?.google?.request),
				model: normalizeGoogleTtsModel(overrides.model ?? config.model),
				voiceName: normalizeGoogleTtsVoiceName(overrides.voiceName ?? config.voiceName),
				audioProfile: overrides.audioProfile ?? config.audioProfile,
				speakerName: overrides.speakerName ?? config.speakerName,
				timeoutMs: req.timeoutMs
			});
			if (req.target === "voice-note") return {
				audioBuffer: await transcodeAudioBufferToOpus({
					audioBuffer: wrapPcm16MonoToWav(pcm),
					inputExtension: "wav",
					tempPrefix: "tts-google-",
					timeoutMs: req.timeoutMs
				}),
				outputFormat: "opus",
				fileExtension: ".opus",
				voiceCompatible: true
			};
			return {
				audioBuffer: wrapPcm16MonoToWav(pcm),
				outputFormat: "wav",
				fileExtension: ".wav",
				voiceCompatible: false
			};
		},
		synthesizeTelephony: async (req) => {
			const config = readGoogleTtsProviderConfig(req.providerConfig);
			const overrides = readGoogleTtsOverrides(req.providerOverrides);
			const apiKey = resolveGoogleTtsApiKey({
				cfg: req.cfg,
				providerConfig: req.providerConfig
			});
			if (!apiKey) throw new Error("Google API key missing");
			return {
				audioBuffer: await synthesizeGoogleTtsPcm({
					text: req.text,
					apiKey,
					baseUrl: resolveGoogleTtsBaseUrl({
						cfg: req.cfg,
						providerConfig: config
					}),
					request: sanitizeConfiguredModelProviderRequest(req.cfg?.models?.providers?.google?.request),
					model: normalizeGoogleTtsModel(overrides.model ?? config.model),
					voiceName: normalizeGoogleTtsVoiceName(overrides.voiceName ?? config.voiceName),
					audioProfile: overrides.audioProfile ?? config.audioProfile,
					speakerName: overrides.speakerName ?? config.speakerName,
					timeoutMs: req.timeoutMs
				}),
				outputFormat: "pcm",
				sampleRate: GOOGLE_TTS_SAMPLE_RATE
			};
		}
	};
}
const testing = {
	DEFAULT_GOOGLE_TTS_MODEL,
	DEFAULT_GOOGLE_TTS_VOICE,
	GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE,
	GOOGLE_TTS_MODELS,
	GOOGLE_TTS_SAMPLE_RATE,
	normalizeGoogleTtsModel,
	renderGoogleAudioProfilePrompt,
	wrapPcm16MonoToWav
};
//#endregion
export { testing as n, buildGoogleSpeechProvider as t };
