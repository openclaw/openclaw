import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CHROMIUM_FULL_VERSION,
  TRUSTED_CLIENT_TOKEN,
  generateSecMsGecToken,
} from "node-edge-tts/dist/drm.js";
import type {
  SpeechProviderConfig,
  SpeechProviderPlugin,
  SpeechVoiceOption,
} from "openclaw/plugin-sdk/speech";
import {
  asBoolean,
  asFiniteNumber,
  asOptionalRecord,
  filterStringRecord,
  normalizeOptionalString as trimToUndefined,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { edgeTTS, inferEdgeExtension } from "./tts.js";

const DEFAULT_EDGE_VOICE = "en-US-MichelleNeural";
const DEFAULT_EDGE_LANG = "en-US";
const DEFAULT_EDGE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const DEFAULT_MICROSOFT_VOICE_LIST_TIMEOUT_MS = 30_000;

type MicrosoftProviderConfig = {
  enabled: boolean;
  voice: string;
  lang: string;
  outputFormat: string;
  outputFormatConfigured: boolean;
  pitch?: string;
  rate?: string;
  volume?: string;
  saveSubtitles: boolean;
  proxy?: string;
  timeoutMs?: number;
};

function normalizeMicrosoftProviderConfig(
  rawConfig: Record<string, unknown>,
): MicrosoftProviderConfig {
  const providers = asOptionalRecord(rawConfig.providers);
  const rawEdge = asOptionalRecord(rawConfig.edge);
  const rawMicrosoft = asOptionalRecord(rawConfig.microsoft);
  const rawProviderMicrosoft = asOptionalRecord(providers?.microsoft);
  const raw = { ...rawEdge, ...rawMicrosoft, ...rawProviderMicrosoft };
  return readMicrosoftProviderConfig({
    ...raw,
    outputFormatConfigured: Boolean(trimToUndefined(raw.outputFormat)),
  });
}

function readMicrosoftProviderConfig(config: SpeechProviderConfig): MicrosoftProviderConfig {
  return {
    enabled: asBoolean(config.enabled) ?? true,
    voice: trimToUndefined(config.voice) ?? DEFAULT_EDGE_VOICE,
    lang: trimToUndefined(config.lang) ?? DEFAULT_EDGE_LANG,
    outputFormat: trimToUndefined(config.outputFormat) ?? DEFAULT_EDGE_OUTPUT_FORMAT,
    outputFormatConfigured: asBoolean(config.outputFormatConfigured) ?? false,
    pitch: trimToUndefined(config.pitch),
    rate: trimToUndefined(config.rate),
    volume: trimToUndefined(config.volume),
    saveSubtitles: asBoolean(config.saveSubtitles) ?? false,
    proxy: trimToUndefined(config.proxy),
    timeoutMs: asFiniteNumber(config.timeoutMs),
  };
}

function buildMicrosoftVoiceHeaders(): Record<string, string> {
  const major = CHROMIUM_FULL_VERSION.split(".")[0] || "0";
  return {
    Authority: "speech.platform.bing.com",
    Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    Accept: "*/*",
    "User-Agent":
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
      `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
    "Sec-MS-GEC": generateSecMsGecToken(),
    "Sec-MS-GEC-Version": `1-${CHROMIUM_FULL_VERSION}`,
  };
}

function readMicrosoftVoiceTagStrings(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : undefined;
}

function isCjkDominant(text: string): boolean {
  const stripped = text.replace(/\s+/g, "");
  if (stripped.length === 0) {
    return false;
  }
  let cjkCount = 0;
  for (const ch of stripped) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjkCount += 1;
    }
  }
  return cjkCount / stripped.length > 0.3;
}

const DEFAULT_CHINESE_EDGE_VOICE = "zh-CN-XiaoxiaoNeural";
const DEFAULT_CHINESE_EDGE_LANG = "zh-CN";

async function listMicrosoftVoices(
  timeoutMs = DEFAULT_MICROSOFT_VOICE_LIST_TIMEOUT_MS,
): Promise<SpeechVoiceOption[]> {
  const { assertOkOrThrowProviderError, readProviderJsonResponse } =
    await import("openclaw/plugin-sdk/provider-http");
  const { captureHttpExchange, isDebugProxyGlobalFetchPatchInstalled } =
    await import("openclaw/plugin-sdk/proxy-capture");
  const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedHostname } =
    await import("openclaw/plugin-sdk/ssrf-runtime");
  const url =
    "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list" +
    `?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;
  const headers = buildMicrosoftVoiceHeaders();
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      headers,
    },
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname("https://speech.platform.bing.com"),
    auditContext: "microsoft.speech.voices",
    timeoutMs,
  });
  try {
    if (!isDebugProxyGlobalFetchPatchInstalled()) {
      captureHttpExchange({
        url,
        method: "GET",
        requestHeaders: headers,
        response,
        transport: "http",
        meta: {
          provider: "microsoft",
          capability: "speech-voices",
        },
      });
    }
    await assertOkOrThrowProviderError(response, "Microsoft voices API error");
    const voices = await readProviderJsonResponse<unknown>(response, "microsoft.speech-voices");
    return Array.isArray(voices)
      ? voices.flatMap((value) => {
          const voice = asOptionalRecord(value);
          const id = trimToUndefined(voice?.ShortName);
          if (!voice || !id) {
            return [];
          }
          const voiceTag = asOptionalRecord(voice.VoiceTag);
          const categories = readMicrosoftVoiceTagStrings(voiceTag?.ContentCategories);
          const personalities = readMicrosoftVoiceTagStrings(voiceTag?.VoicePersonalities);
          return [
            {
              id,
              name: trimToUndefined(voice.FriendlyName) ?? id,
              category: categories?.[0],
              description: personalities?.length ? personalities.join(", ") : undefined,
              locale: trimToUndefined(voice.Locale),
              gender: trimToUndefined(voice.Gender),
              personalities,
            },
          ];
        })
      : [];
  } finally {
    await release();
  }
}

export function buildMicrosoftSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "microsoft",
    label: "Microsoft",
    aliases: ["edge"],
    autoSelectOrder: 30,
    resolveConfig: ({ rawConfig }) => normalizeMicrosoftProviderConfig(rawConfig),
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeMicrosoftProviderConfig(baseTtsConfig);
      return {
        ...base,
        enabled: true,
        ...filterStringRecord({
          voice: trimToUndefined(talkProviderConfig.voiceId),
          lang: trimToUndefined(talkProviderConfig.languageCode),
          outputFormat: trimToUndefined(talkProviderConfig.outputFormat),
          pitch: trimToUndefined(talkProviderConfig.pitch),
          rate: trimToUndefined(talkProviderConfig.rate),
          volume: trimToUndefined(talkProviderConfig.volume),
          proxy: trimToUndefined(talkProviderConfig.proxy),
        }),
        ...(asFiniteNumber(talkProviderConfig.timeoutMs) == null
          ? {}
          : { timeoutMs: asFiniteNumber(talkProviderConfig.timeoutMs) }),
      };
    },
    resolveTalkOverrides: ({ params }) =>
      filterStringRecord({
        voice: trimToUndefined(params.voiceId),
        outputFormat: trimToUndefined(params.outputFormat),
      }) ?? {},
    listVoices: async (req) => {
      const config = readMicrosoftProviderConfig(req.providerConfig ?? {});
      return await listMicrosoftVoices(config.timeoutMs ?? req.timeoutMs);
    },
    isConfigured: ({ providerConfig }) => readMicrosoftProviderConfig(providerConfig).enabled,
    synthesize: async (req) => {
      const config = readMicrosoftProviderConfig(req.providerConfig);
      const { isVoiceMessageCompatibleAudio } = await import("openclaw/plugin-sdk/media-runtime");
      const { tempWorkspace, resolvePreferredOpenClawTmpDir } =
        await import("openclaw/plugin-sdk/temp-path");
      const temp = await tempWorkspace({
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix: "tts-microsoft-",
      });
      const tempDir = temp.dir;
      const overrideVoice = trimToUndefined(req.providerOverrides?.voice);
      let voice = overrideVoice ?? config.voice;
      let lang = config.lang;
      const outputFormat =
        trimToUndefined(req.providerOverrides?.outputFormat) ?? config.outputFormat;
      const fallbackOutputFormat =
        outputFormat !== DEFAULT_EDGE_OUTPUT_FORMAT ? DEFAULT_EDGE_OUTPUT_FORMAT : undefined;

      if (!overrideVoice && voice === DEFAULT_EDGE_VOICE && isCjkDominant(req.text)) {
        voice = DEFAULT_CHINESE_EDGE_VOICE;
        lang = DEFAULT_CHINESE_EDGE_LANG;
      }

      try {
        const runEdge = async (format: string) => {
          const fileExtension = inferEdgeExtension(format);
          const outputPath = path.join(tempDir, `speech${fileExtension}`);
          await edgeTTS({
            text: req.text,
            outputPath,
            config: {
              ...config,
              voice,
              lang,
              outputFormat: format,
            },
            timeoutMs: req.timeoutMs,
          });
          const audioBuffer = readFileSync(outputPath);
          return {
            audioBuffer,
            outputFormat: format,
            fileExtension,
            voiceCompatible: isVoiceMessageCompatibleAudio({ fileName: outputPath }),
          };
        };

        try {
          return await runEdge(outputFormat);
        } catch (error) {
          if (!fallbackOutputFormat) {
            throw error;
          }
          return await runEdge(fallbackOutputFormat);
        }
      } finally {
        await temp.cleanup();
      }
    },
  };
}
