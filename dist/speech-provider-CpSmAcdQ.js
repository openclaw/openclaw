import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import { t as tempWorkspace } from "./private-temp-workspace-DgditT3G.js";
import { t as asFiniteNumber } from "./number-coercion-CgoBR0cm.js";
import { y as ssrfPolicyFromHttpBaseUrlAllowedHostname } from "./ssrf-DdDeGa5L.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import "./temp-path-DllZid8c.js";
import { i as assertOkOrThrowProviderError, n as asObject, t as asBoolean } from "./provider-http-errors-C90BH-le.js";
import { a as isDebugProxyGlobalFetchPatchInstalled, t as captureHttpExchange } from "./runtime-Cqhsh14m.js";
import "./proxy-capture-v_LMACCK.js";
import { r as isVoiceCompatibleAudio } from "./audio-CVFIRHpA.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./media-runtime-BheBFFxc.js";
import "./provider-http-CYBE-CBM.js";
import "./speech-DNHVYL_R.js";
import { n as inferEdgeExtension, t as edgeTTS } from "./tts-LvvbG8xn.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CHROMIUM_FULL_VERSION, TRUSTED_CLIENT_TOKEN, generateSecMsGecToken } from "node-edge-tts/dist/drm.js";
//#region extensions/microsoft/speech-provider.ts
const DEFAULT_EDGE_VOICE = "en-US-MichelleNeural";
const DEFAULT_EDGE_LANG = "en-US";
const DEFAULT_EDGE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
function normalizeMicrosoftProviderConfig(rawConfig) {
	const providers = asObject(rawConfig.providers);
	const rawEdge = asObject(rawConfig.edge);
	const rawMicrosoft = asObject(rawConfig.microsoft);
	const rawProviderMicrosoft = asObject(providers?.microsoft);
	const raw = {
		...rawEdge,
		...rawMicrosoft,
		...rawProviderMicrosoft
	};
	const outputFormat = normalizeOptionalString(raw.outputFormat);
	return {
		enabled: asBoolean(raw.enabled) ?? true,
		voice: normalizeOptionalString(raw.voice) ?? DEFAULT_EDGE_VOICE,
		lang: normalizeOptionalString(raw.lang) ?? DEFAULT_EDGE_LANG,
		outputFormat: outputFormat ?? DEFAULT_EDGE_OUTPUT_FORMAT,
		outputFormatConfigured: Boolean(outputFormat),
		pitch: normalizeOptionalString(raw.pitch),
		rate: normalizeOptionalString(raw.rate),
		volume: normalizeOptionalString(raw.volume),
		saveSubtitles: asBoolean(raw.saveSubtitles) ?? false,
		proxy: normalizeOptionalString(raw.proxy),
		timeoutMs: asFiniteNumber(raw.timeoutMs)
	};
}
function readMicrosoftProviderConfig(config) {
	const defaults = normalizeMicrosoftProviderConfig({});
	return {
		enabled: asBoolean(config.enabled) ?? defaults.enabled,
		voice: normalizeOptionalString(config.voice) ?? defaults.voice,
		lang: normalizeOptionalString(config.lang) ?? defaults.lang,
		outputFormat: normalizeOptionalString(config.outputFormat) ?? defaults.outputFormat,
		outputFormatConfigured: asBoolean(config.outputFormatConfigured) ?? defaults.outputFormatConfigured,
		pitch: normalizeOptionalString(config.pitch) ?? defaults.pitch,
		rate: normalizeOptionalString(config.rate) ?? defaults.rate,
		volume: normalizeOptionalString(config.volume) ?? defaults.volume,
		saveSubtitles: asBoolean(config.saveSubtitles) ?? defaults.saveSubtitles,
		proxy: normalizeOptionalString(config.proxy) ?? defaults.proxy,
		timeoutMs: asFiniteNumber(config.timeoutMs) ?? defaults.timeoutMs
	};
}
function buildMicrosoftVoiceHeaders() {
	const major = CHROMIUM_FULL_VERSION.split(".")[0] || "0";
	return {
		Authority: "speech.platform.bing.com",
		Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
		Accept: "*/*",
		"User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
		"Sec-MS-GEC": generateSecMsGecToken(),
		"Sec-MS-GEC-Version": `1-${CHROMIUM_FULL_VERSION}`
	};
}
function formatMicrosoftVoiceDescription(entry) {
	const personalities = entry.VoiceTag?.VoicePersonalities?.filter(Boolean) ?? [];
	return personalities.length > 0 ? personalities.join(", ") : void 0;
}
function isCjkDominant(text) {
	const stripped = text.replace(/\s+/g, "");
	if (stripped.length === 0) return false;
	let cjkCount = 0;
	for (const ch of stripped) {
		const code = ch.codePointAt(0) ?? 0;
		if (code >= 19968 && code <= 40959 || code >= 13312 && code <= 19903 || code >= 12288 && code <= 12351 || code >= 65280 && code <= 65519) cjkCount += 1;
	}
	return cjkCount / stripped.length > .3;
}
const DEFAULT_CHINESE_EDGE_VOICE = "zh-CN-XiaoxiaoNeural";
const DEFAULT_CHINESE_EDGE_LANG = "zh-CN";
async function listMicrosoftVoices() {
	const url = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;
	const headers = buildMicrosoftVoiceHeaders();
	const { response, release } = await fetchWithSsrFGuard({
		url,
		init: { headers },
		policy: ssrfPolicyFromHttpBaseUrlAllowedHostname("https://speech.platform.bing.com"),
		auditContext: "microsoft.speech.voices"
	});
	try {
		if (!isDebugProxyGlobalFetchPatchInstalled()) captureHttpExchange({
			url,
			method: "GET",
			requestHeaders: headers,
			response,
			transport: "http",
			meta: {
				provider: "microsoft",
				capability: "speech-voices"
			}
		});
		await assertOkOrThrowProviderError(response, "Microsoft voices API error");
		const voices = await response.json();
		return Array.isArray(voices) ? voices.map((voice) => ({
			id: voice.ShortName?.trim() ?? "",
			name: normalizeOptionalString(voice.FriendlyName) ?? normalizeOptionalString(voice.ShortName),
			category: voice.VoiceTag?.ContentCategories?.find((value) => value.trim().length > 0),
			description: formatMicrosoftVoiceDescription(voice),
			locale: normalizeOptionalString(voice.Locale),
			gender: normalizeOptionalString(voice.Gender),
			personalities: voice.VoiceTag?.VoicePersonalities?.filter((value) => value.trim().length > 0)
		})).filter((voice) => voice.id.length > 0) : [];
	} finally {
		await release();
	}
}
function buildMicrosoftSpeechProvider() {
	return {
		id: "microsoft",
		label: "Microsoft",
		aliases: ["edge"],
		autoSelectOrder: 30,
		resolveConfig: ({ rawConfig }) => normalizeMicrosoftProviderConfig(rawConfig),
		resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
			return {
				...normalizeMicrosoftProviderConfig(baseTtsConfig),
				enabled: true,
				...normalizeOptionalString(talkProviderConfig.voiceId) == null ? {} : { voice: normalizeOptionalString(talkProviderConfig.voiceId) },
				...normalizeOptionalString(talkProviderConfig.languageCode) == null ? {} : { lang: normalizeOptionalString(talkProviderConfig.languageCode) },
				...normalizeOptionalString(talkProviderConfig.outputFormat) == null ? {} : { outputFormat: normalizeOptionalString(talkProviderConfig.outputFormat) },
				...normalizeOptionalString(talkProviderConfig.pitch) == null ? {} : { pitch: normalizeOptionalString(talkProviderConfig.pitch) },
				...normalizeOptionalString(talkProviderConfig.rate) == null ? {} : { rate: normalizeOptionalString(talkProviderConfig.rate) },
				...normalizeOptionalString(talkProviderConfig.volume) == null ? {} : { volume: normalizeOptionalString(talkProviderConfig.volume) },
				...normalizeOptionalString(talkProviderConfig.proxy) == null ? {} : { proxy: normalizeOptionalString(talkProviderConfig.proxy) },
				...asFiniteNumber(talkProviderConfig.timeoutMs) == null ? {} : { timeoutMs: asFiniteNumber(talkProviderConfig.timeoutMs) }
			};
		},
		resolveTalkOverrides: ({ params }) => ({
			...normalizeOptionalString(params.voiceId) == null ? {} : { voice: normalizeOptionalString(params.voiceId) },
			...normalizeOptionalString(params.outputFormat) == null ? {} : { outputFormat: normalizeOptionalString(params.outputFormat) }
		}),
		listVoices: async () => await listMicrosoftVoices(),
		isConfigured: ({ providerConfig }) => readMicrosoftProviderConfig(providerConfig).enabled,
		synthesize: async (req) => {
			const config = readMicrosoftProviderConfig(req.providerConfig);
			const temp = await tempWorkspace({
				rootDir: resolvePreferredOpenClawTmpDir(),
				prefix: "tts-microsoft-"
			});
			const tempDir = temp.dir;
			const overrideVoice = normalizeOptionalString(req.providerOverrides?.voice);
			let voice = overrideVoice ?? config.voice;
			let lang = config.lang;
			let outputFormat = normalizeOptionalString(req.providerOverrides?.outputFormat) ?? config.outputFormat;
			const fallbackOutputFormat = outputFormat !== DEFAULT_EDGE_OUTPUT_FORMAT ? DEFAULT_EDGE_OUTPUT_FORMAT : void 0;
			if (!overrideVoice && voice === DEFAULT_EDGE_VOICE && isCjkDominant(req.text)) {
				voice = DEFAULT_CHINESE_EDGE_VOICE;
				lang = DEFAULT_CHINESE_EDGE_LANG;
			}
			try {
				const runEdge = async (format) => {
					const fileExtension = inferEdgeExtension(format);
					const outputPath = path.join(tempDir, `speech${fileExtension}`);
					await edgeTTS({
						text: req.text,
						outputPath,
						config: {
							...config,
							voice,
							lang,
							outputFormat: format
						},
						timeoutMs: req.timeoutMs
					});
					return {
						audioBuffer: readFileSync(outputPath),
						outputFormat: format,
						fileExtension,
						voiceCompatible: isVoiceCompatibleAudio({ fileName: outputPath })
					};
				};
				try {
					return await runEdge(outputFormat);
				} catch (error) {
					if (!fallbackOutputFormat || fallbackOutputFormat === outputFormat) throw error;
					outputFormat = fallbackOutputFormat;
					return await runEdge(outputFormat);
				}
			} finally {
				await temp.cleanup();
			}
		}
	};
}
//#endregion
export { isCjkDominant as n, listMicrosoftVoices as r, buildMicrosoftSpeechProvider as t };
