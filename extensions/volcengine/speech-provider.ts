import * as crypto from "node:crypto";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type { SpeechProviderConfig, SpeechProviderPlugin } from "openclaw/plugin-sdk/speech-core";
import {
  createSpeechDirectiveParser,
  resolveSpeechProviderApiKey,
} from "openclaw/plugin-sdk/speech-provider";
import {
  asFiniteNumberInRange,
  asOptionalRecord,
  isRecord,
  normalizeOptionalString as trimToUndefined,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const DEFAULT_VOICE = "en_female_anna_mars_bigtts";
const DEFAULT_CLUSTER = "volcano_tts";
const DEFAULT_RESOURCE_ID = "seed-tts-1.0";
const DEFAULT_APP_KEY = "aGjiRDfUWi";

const VOLCENGINE_TTS_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const BYTEPLUS_SEED_TTS_URL =
  "https://voice.ap-southeast-1.bytepluses.com/api/v3/tts/unidirectional";
const VOLCENGINE_LEGACY_TTS_URL = "https://openspeech.bytedance.com/api/v1/tts";

type VolcengineTtsResponse = {
  code?: number;
  message?: string;
  data?: string;
};

function parseJsonObject(text: string, providerName: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      throw new Error("expected JSON object");
    }
    return parsed;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${providerName} TTS: failed to parse response JSON: ${detail}`, {
      cause: err,
    });
  }
}

function toTtsResponse(parsed: Record<string, unknown>): VolcengineTtsResponse {
  const header = asOptionalRecord(parsed.header);
  return {
    code:
      typeof parsed.code === "number"
        ? parsed.code
        : typeof header?.code === "number"
          ? header.code
          : undefined,
    message:
      typeof parsed.message === "string"
        ? parsed.message
        : typeof header?.message === "string"
          ? header.message
          : undefined,
    data: typeof parsed.data === "string" ? parsed.data : undefined,
  };
}

function parseSeedTtsFrames(text: string): VolcengineTtsResponse[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  try {
    return [toTtsResponse(parseJsonObject(trimmed, "BytePlus Seed Speech"))];
  } catch {
    // The HTTP API streams JSON frames; Response.text() preserves line breaks.
  }

  const frames: VolcengineTtsResponse[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const item = line.trim();
    if (!item) {
      continue;
    }
    const json = item.startsWith("data:") ? item.slice("data:".length).trim() : item;
    frames.push(toTtsResponse(parseJsonObject(json, "BytePlus Seed Speech")));
  }
  return frames;
}

const VOLCENGINE_VOICES: readonly string[] = [
  "en_female_anna_mars_bigtts",
  "en_male_adam_mars_bigtts",
  "en_female_sarah_mars_bigtts",
  "en_male_smith_mars_bigtts",
  "zh_female_cancan_mars_bigtts",
  "zh_female_qingxinnvsheng_mars_bigtts",
  "zh_female_linjia_mars_bigtts",
  "zh_male_wennuanahu_moon_bigtts",
  "zh_male_shaonianzixin_moon_bigtts",
  "zh_female_shuangkuaisisi_moon_bigtts",
];

function normalizeSpeedRatio(value: unknown): number | undefined {
  return asFiniteNumberInRange(value, { min: 0.2, max: 3 });
}

function normalizeVolcengineProviderConfig(rawConfig: Record<string, unknown>) {
  const providers = asOptionalRecord(rawConfig.providers);
  const raw = asOptionalRecord(providers?.volcengine);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "tts.providers.volcengine.apiKey",
    }),
    appId: trimToUndefined(raw?.appId),
    token: normalizeResolvedSecretInputString({
      value: raw?.token,
      path: "tts.providers.volcengine.token",
    }),
    voice:
      trimToUndefined(raw?.voice) ??
      trimToUndefined(process.env.VOLCENGINE_TTS_VOICE) ??
      DEFAULT_VOICE,
    cluster:
      trimToUndefined(raw?.cluster) ??
      trimToUndefined(process.env.VOLCENGINE_TTS_CLUSTER) ??
      DEFAULT_CLUSTER,
    resourceId:
      trimToUndefined(raw?.resourceId) ??
      trimToUndefined(process.env.VOLCENGINE_TTS_RESOURCE_ID) ??
      DEFAULT_RESOURCE_ID,
    appKey:
      trimToUndefined(raw?.appKey) ??
      trimToUndefined(process.env.VOLCENGINE_TTS_APP_KEY) ??
      DEFAULT_APP_KEY,
    baseUrl: trimToUndefined(raw?.baseUrl) ?? trimToUndefined(process.env.VOLCENGINE_TTS_BASE_URL),
    speedRatio: normalizeSpeedRatio(raw?.speedRatio),
    emotion: trimToUndefined(raw?.emotion),
  };
}

function resolveSeedSpeechApiKey(configApiKey?: string): string | undefined {
  return resolveSpeechProviderApiKey(
    configApiKey,
    process.env.VOLCENGINE_TTS_API_KEY,
    process.env.BYTEPLUS_SEED_SPEECH_API_KEY,
  );
}

function resolveLegacyVolcengineCredentials(config: { appId?: string; token?: string }) {
  return {
    appId: trimToUndefined(config.appId) ?? trimToUndefined(process.env.VOLCENGINE_TTS_APPID),
    token: resolveSpeechProviderApiKey(config.token, process.env.VOLCENGINE_TTS_TOKEN),
  };
}

function readProviderConfig(config: SpeechProviderConfig) {
  return normalizeVolcengineProviderConfig({
    providers: { volcengine: { ...config, token: trimToUndefined(config.token) } },
  });
}

const parseDirectiveToken = createSpeechDirectiveParser({
  voice: ["allowVoice", ["voice", "volcengine_voice", "volcenginevoice"]],
  speedRatio: [
    "allowVoiceSettings",
    ["speed", "speedratio", "speed_ratio"],
    {
      number: {
        range: { min: 0.2, max: 3 },
        warning: (value) => `invalid Volcengine speedRatio "${value}"`,
      },
    },
  ],
  emotion: ["allowVoiceSettings", ["emotion"]],
});

export function buildVolcengineSpeechProvider(): SpeechProviderPlugin {
  const isConfigured: NonNullable<SpeechProviderPlugin["isConfigured"]> = ({ providerConfig }) => {
    const cfg = readProviderConfig(providerConfig);
    const legacy = resolveLegacyVolcengineCredentials(cfg);
    return Boolean(resolveSeedSpeechApiKey(cfg.apiKey) || (legacy.appId && legacy.token));
  };
  return {
    id: "volcengine",
    label: "Volcengine",
    autoSelectOrder: 90,
    aliases: ["bytedance", "doubao"],
    voices: VOLCENGINE_VOICES,
    resolveConfig: ({ rawConfig }) => normalizeVolcengineProviderConfig(rawConfig),
    parseDirectiveToken,

    listVoices: async () =>
      VOLCENGINE_VOICES.map((v) => ({
        id: v,
        name: v.replace(/^(?:en|zh)_(female|male)_/, "").replace(/_.*$/, ""),
        locale: v.startsWith("en_") ? "en-US" : "zh-CN",
        gender: v.includes("_female_") ? "female" : "male",
      })),

    // Retained for synchronous SDK consumers through 2026-12-31.
    isConfigured,
    isConfiguredAsync: async (ctx) => isConfigured(ctx),
    synthesize: async (req) => {
      const cfg = readProviderConfig(req.providerConfig);
      const overrides = req.providerOverrides;
      const apiKey = resolveSeedSpeechApiKey(cfg.apiKey);
      const { appId, token } = resolveLegacyVolcengineCredentials(cfg);

      if (!apiKey && (!appId || !token)) {
        throw new Error(
          "Volcengine TTS credentials missing. Set VOLCENGINE_TTS_API_KEY, " +
            "BYTEPLUS_SEED_SPEECH_API_KEY, or legacy VOLCENGINE_TTS_APPID and VOLCENGINE_TTS_TOKEN.",
        );
      }

      const isVoiceNote = req.target === "voice-note";
      const encoding = isVoiceNote ? "ogg_opus" : "mp3";
      const voice = trimToUndefined(overrides?.voice) ?? cfg.voice;
      const { cluster, resourceId, appKey } = cfg;
      const baseUrl = cfg.baseUrl ?? (apiKey ? BYTEPLUS_SEED_TTS_URL : VOLCENGINE_LEGACY_TTS_URL);
      const speedRatio = normalizeSpeedRatio(overrides?.speedRatio) ?? cfg.speedRatio ?? 1;
      const emotion = trimToUndefined(overrides?.emotion) ?? cfg.emotion;
      const { text, timeoutMs } = req;
      const { canonicalizeBase64 } = await import("openclaw/plugin-sdk/media-runtime");
      const { readResponseWithLimit } = await import("openclaw/plugin-sdk/response-limit-runtime");
      const { fetchWithSsrFGuard } = await import("openclaw/plugin-sdk/ssrf-runtime");
      const providerName = apiKey ? "BytePlus Seed Speech" : "Volcengine";
      const payload = apiKey
        ? {
            user: { uid: "openclaw" },
            req_params: {
              text,
              speaker: voice,
              audio_params: {
                format: encoding,
                sample_rate: 24_000,
              },
              ...(speedRatio !== 1 ? { speed_ratio: speedRatio } : {}),
              ...(emotion ? { emotion } : {}),
            },
          }
        : {
            app: { appid: appId, token, cluster },
            user: { uid: "openclaw" },
            audio: {
              voice_type: voice,
              encoding,
              speed_ratio: speedRatio,
              volume_ratio: 1,
              pitch_ratio: 1,
              ...(emotion ? { emotion } : {}),
            },
            request: {
              reqid: crypto.randomUUID(),
              text,
              text_type: "plain",
              operation: "query",
            },
          };
      const { response, release } = await fetchWithSsrFGuard({
        url: baseUrl,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey
              ? {
                  Connection: "keep-alive",
                  "X-Api-Key": apiKey,
                  "X-Api-Resource-Id": resourceId,
                  "X-Api-App-Key": appKey,
                }
              : { Authorization: `Bearer;${token}` }),
          },
          body: JSON.stringify(payload),
        },
        timeoutMs,
        policy: { hostnameAllowlist: [new URL(baseUrl).hostname] },
        auditContext: "volcengine.tts",
      });

      let audioBuffer: Buffer;
      try {
        const responseText = new TextDecoder("utf-8", { fatal: true }).decode(
          await readResponseWithLimit(response, VOLCENGINE_TTS_RESPONSE_MAX_BYTES, {
            onOverflow: ({ maxBytes }) =>
              new Error(`${providerName} TTS response exceeds ${maxBytes} bytes`),
          }),
        );
        if (!apiKey) {
          const body = toTtsResponse(parseJsonObject(responseText, providerName));
          if (!response.ok || body.code !== 3000 || !body.data) {
            throw new Error(
              `Volcengine TTS error ${body.code ?? response.status}: ${body.message ?? "unknown"}`,
            );
          }
          const canonicalAudio = canonicalizeBase64(body.data);
          if (!canonicalAudio) {
            throw new Error("Volcengine TTS returned malformed base64 audio data");
          }
          audioBuffer = Buffer.from(canonicalAudio, "base64");
        } else {
          const frames = parseSeedTtsFrames(responseText);
          const chunks: Buffer[] = [];
          for (const frame of frames) {
            if (frame.code === 0) {
              if (frame.data) {
                const canonicalAudio = canonicalizeBase64(frame.data);
                if (!canonicalAudio) {
                  throw new Error("BytePlus Seed Speech TTS returned malformed base64 audio data");
                }
                chunks.push(Buffer.from(canonicalAudio, "base64"));
              }
              continue;
            }
            if (frame.code === 20000000) {
              continue;
            }
            throw new Error(
              `BytePlus Seed Speech TTS error ${frame.code ?? response.status}: ${
                frame.message ?? "unknown"
              }`,
            );
          }

          if (!response.ok || chunks.length === 0) {
            throw new Error(`BytePlus Seed Speech TTS error ${response.status}: no audio data`);
          }

          audioBuffer = Buffer.concat(chunks);
        }
      } finally {
        await release();
      }

      return {
        audioBuffer,
        outputFormat: encoding === "ogg_opus" ? "opus" : "mp3",
        fileExtension: encoding === "ogg_opus" ? ".opus" : ".mp3",
        voiceCompatible: isVoiceNote,
      };
    },
  };
}
