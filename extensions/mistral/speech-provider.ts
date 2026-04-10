import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { requireApiKey, resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech";
import {
  asObject,
  readResponseTextLimited,
  trimToUndefined,
  truncateErrorDetail,
} from "openclaw/plugin-sdk/speech";
import { MISTRAL_BASE_URL } from "./model-definitions.js";

const DEFAULT_MISTRAL_TTS_MODEL = "voxtral-mini-tts-2603";

type MistralTtsProviderConfig = {
  apiKey?: string;
  baseUrl: string;
  model: string;
  voice: string;
  speed?: number;
};

type MistralTtsProviderOverrides = {
  model?: string;
  voice?: string;
  speed?: number;
};

function normalizeProviderId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hasConfiguredSecret(value: unknown): boolean {
  return (typeof value === "string" && value.trim().length > 0) || asObject(value) != null;
}

function normalizeMistralTtsBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : MISTRAL_BASE_URL;
}

function findMistralModelProviderConfig(cfg?: OpenClawConfig): Record<string, unknown> | undefined {
  const providers = asObject(cfg?.models?.providers);
  if (!providers) {
    return undefined;
  }
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (normalizeProviderId(providerId) === "mistral") {
      return asObject(providerConfig);
    }
  }
  return undefined;
}

function hasConfiguredMistralAuthProfileMetadata(cfg?: OpenClawConfig): boolean {
  const profiles = asObject(cfg?.auth?.profiles);
  return Boolean(
    profiles &&
    Object.values(profiles).some(
      (profile) => normalizeProviderId(asObject(profile)?.provider) === "mistral",
    ),
  );
}

function hasConfiguredMistralAuthOrder(cfg?: OpenClawConfig): boolean {
  const order = asObject(cfg?.auth?.order);
  if (!order) {
    return false;
  }
  // auth.order keys are provider IDs; check if any key normalizes to "mistral"
  // and has at least one profile ID entry, matching what resolveAuthProfileOrder does.
  return Object.entries(order).some(([providerId, profileIds]) => {
    if (normalizeProviderId(providerId) !== "mistral") {
      return false;
    }
    return Array.isArray(profileIds) && profileIds.length > 0;
  });
}

function normalizeMistralProviderConfig(
  rawConfig: Record<string, unknown>,
  cfg?: OpenClawConfig,
): MistralTtsProviderConfig {
  const providers = asObject(rawConfig.providers);
  const raw = asObject(providers?.mistral) ?? asObject(rawConfig.mistral);
  const modelProvider = findMistralModelProviderConfig(cfg);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "messages.tts.providers.mistral.apiKey",
    }),
    baseUrl: normalizeMistralTtsBaseUrl(
      trimToUndefined(raw?.baseUrl) ??
        trimToUndefined(process.env.MISTRAL_TTS_BASE_URL) ??
        trimToUndefined(modelProvider?.baseUrl),
    ),
    model: trimToUndefined(raw?.model) ?? DEFAULT_MISTRAL_TTS_MODEL,
    voice: trimToUndefined(raw?.voice) ?? "",
    speed: asNumber(raw?.speed),
  };
}

function readMistralProviderConfig(
  config: SpeechProviderConfig,
  cfg?: OpenClawConfig,
): MistralTtsProviderConfig {
  const normalized = normalizeMistralProviderConfig({}, cfg);
  return {
    apiKey: trimToUndefined(config.apiKey) ?? normalized.apiKey,
    baseUrl: normalizeMistralTtsBaseUrl(trimToUndefined(config.baseUrl) ?? normalized.baseUrl),
    model: trimToUndefined(config.model) ?? normalized.model,
    voice: trimToUndefined(config.voice) ?? normalized.voice,
    speed: asNumber(config.speed) ?? normalized.speed,
  };
}

function readMistralOverrides(
  overrides: SpeechProviderOverrides | undefined,
): MistralTtsProviderOverrides {
  if (!overrides) {
    return {};
  }
  return {
    model: trimToUndefined(overrides.model),
    voice: trimToUndefined(overrides.voice),
    speed: asNumber(overrides.speed),
  };
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext): {
  handled: boolean;
  overrides?: SpeechProviderOverrides;
  warnings?: string[];
} {
  switch (ctx.key) {
    case "mistralvoice":
    case "mistralvoiceid":
    case "mistral_voice":
    case "mistral_voice_id":
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      if (!ctx.value.trim()) {
        return { handled: true, warnings: [`invalid Mistral voice "${ctx.value}"`] };
      }
      return { handled: true, overrides: { voice: ctx.value.trim() } };
    case "mistralmodel":
    case "mistralmodelid":
    case "mistral_model":
      if (!ctx.policy.allowModelId) {
        return { handled: true };
      }
      if (!ctx.value.trim()) {
        return { handled: true, warnings: [`invalid Mistral model "${ctx.value}"`] };
      }
      return { handled: true, overrides: { model: ctx.value.trim() } };
    default:
      return { handled: false };
  }
}

function decodeBase64Audio(value: string): Buffer {
  return Buffer.from(value, "base64");
}

type WavChunkInfo = {
  audioData: Buffer;
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  /** 1 = PCM integer, 3 = IEEE float */
  audioFormat: number;
};

function getRiffChunkSpan(chunkSize: number): number {
  // RIFF chunks are word-aligned, so odd-length payloads include a 1-byte pad.
  return 8 + chunkSize + (chunkSize % 2);
}

function parseWavChunk(buffer: Buffer): WavChunkInfo {
  if (buffer.length < 44) {
    throw new Error("Mistral TTS WAV response too short");
  }
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Mistral TTS WAV response is not a valid RIFF/WAVE file");
  }
  if (buffer.toString("ascii", 12, 16) !== "fmt ") {
    throw new Error("Mistral TTS WAV response missing fmt chunk");
  }
  const fmtSize = buffer.readUInt32LE(16);
  const audioFormat = buffer.readUInt16LE(20);
  const numChannels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);

  // Scan for the data chunk (there may be additional chunks between fmt and data)
  let offset = 12 + getRiffChunkSpan(fmtSize);
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      const audioData = buffer.subarray(offset + 8, offset + 8 + chunkSize);
      return { audioData, sampleRate, numChannels, bitsPerSample, audioFormat };
    }
    offset += getRiffChunkSpan(chunkSize);
  }
  throw new Error("Mistral TTS WAV response missing data chunk");
}

/**
 * Decode a Mistral WAV response to mono s16le PCM.
 * Handles f32le (audioFormat=3) and s16le (audioFormat=1) WAV sources.
 * Returns the raw s16le buffer and the sample rate from the WAV header.
 */
export function decodeMistralWavToS16le(buffer: Buffer): {
  audioBuffer: Buffer;
  sampleRate: number;
} {
  const { audioData, sampleRate, numChannels, bitsPerSample, audioFormat } = parseWavChunk(buffer);

  if (audioFormat === 3 && bitsPerSample === 32) {
    // f32le → s16le (mix to mono if needed)
    const samplesPerFrame = numChannels;
    const frames = Math.floor(audioData.length / (4 * samplesPerFrame));
    const output = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let ch = 0; ch < samplesPerFrame; ch++) {
        sum += audioData.readFloatLE((i * samplesPerFrame + ch) * 4);
      }
      const sample = Math.round((sum / samplesPerFrame) * 32767);
      output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
    }
    return { audioBuffer: output, sampleRate };
  }

  if (audioFormat === 1 && bitsPerSample === 16) {
    // Already s16le — mix to mono if needed
    if (numChannels === 1) {
      return { audioBuffer: audioData, sampleRate };
    }
    const frames = Math.floor(audioData.length / (2 * numChannels));
    const output = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        sum += audioData.readInt16LE((i * numChannels + ch) * 2);
      }
      output.writeInt16LE(Math.round(sum / numChannels), i * 2);
    }
    return { audioBuffer: output, sampleRate };
  }

  throw new Error(
    `Mistral TTS WAV: unsupported format (audioFormat=${audioFormat}, bitsPerSample=${bitsPerSample})`,
  );
}

function formatMistralErrorPayload(payload: unknown): string | undefined {
  const root = asObject(payload);
  const subject = asObject(root?.error) ?? root;
  if (!subject) {
    return undefined;
  }
  const message =
    trimToUndefined(subject.message) ??
    trimToUndefined(subject.detail) ??
    trimToUndefined(root?.message);
  const type = trimToUndefined(subject.type);
  const code = trimToUndefined(subject.code);
  const metadata = [type ? `type=${type}` : undefined, code ? `code=${code}` : undefined]
    .filter((value): value is string => Boolean(value))
    .join(", ");
  if (message && metadata) {
    return `${truncateErrorDetail(message)} [${metadata}]`;
  }
  if (message) {
    return truncateErrorDetail(message);
  }
  if (metadata) {
    return `[${metadata}]`;
  }
  return undefined;
}

async function extractMistralErrorDetail(response: Response): Promise<string | undefined> {
  const rawBody = trimToUndefined(await readResponseTextLimited(response));
  if (!rawBody) {
    return undefined;
  }
  try {
    return formatMistralErrorPayload(JSON.parse(rawBody)) ?? truncateErrorDetail(rawBody);
  } catch {
    return truncateErrorDetail(rawBody);
  }
}

async function resolveMistralApiKey(params: {
  cfg: OpenClawConfig;
  providerConfig: MistralTtsProviderConfig;
}): Promise<string> {
  const configuredApiKey = params.providerConfig.apiKey;
  if (configuredApiKey) {
    return configuredApiKey;
  }
  const auth = await resolveApiKeyForProvider({
    provider: "mistral",
    cfg: params.cfg,
  });
  return requireApiKey(auth, "mistral");
}

async function mistralTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
  speed?: number;
  responseFormat: "mp3" | "opus" | "pcm" | "wav";
  timeoutMs: number;
}): Promise<Buffer> {
  const { text, apiKey, baseUrl, model, voice, speed, responseFormat, timeoutMs } = params;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: text,
        ...(voice ? { voice_id: voice } : {}),
        response_format: responseFormat,
        ...(speed != null && { speed }),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await extractMistralErrorDetail(response);
      throw new Error(`Mistral TTS API error (${response.status})${detail ? `: ${detail}` : ""}`);
    }

    // Voxtral returns synthesized audio inside a JSON envelope instead of
    // streaming raw audio bytes directly like the OpenAI TTS endpoint.
    const payload = (await response.json()) as Record<string, unknown>;
    const audioData = trimToUndefined(payload.audio_data);
    if (!audioData) {
      throw new Error("Mistral TTS response missing audio_data");
    }
    return decodeBase64Audio(audioData);
  } finally {
    clearTimeout(timeout);
  }
}

export function buildMistralSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "mistral",
    label: "Mistral",
    autoSelectOrder: 15,
    models: [DEFAULT_MISTRAL_TTS_MODEL],
    resolveConfig: ({ cfg, rawConfig }) => normalizeMistralProviderConfig(rawConfig, cfg),
    parseDirectiveToken,
    resolveTalkConfig: ({ cfg, baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeMistralProviderConfig(baseTtsConfig, cfg);
      return {
        ...base,
        ...(talkProviderConfig.apiKey === undefined
          ? {}
          : {
              apiKey: normalizeResolvedSecretInputString({
                value: talkProviderConfig.apiKey,
                path: "talk.providers.mistral.apiKey",
              }),
            }),
        ...(trimToUndefined(talkProviderConfig.baseUrl) == null
          ? {}
          : { baseUrl: normalizeMistralTtsBaseUrl(trimToUndefined(talkProviderConfig.baseUrl)) }),
        ...(trimToUndefined(talkProviderConfig.modelId) == null
          ? {}
          : { model: trimToUndefined(talkProviderConfig.modelId) }),
        ...(trimToUndefined(talkProviderConfig.voiceId) == null
          ? {}
          : { voice: trimToUndefined(talkProviderConfig.voiceId) }),
        ...(asNumber(talkProviderConfig.speed) == null
          ? {}
          : { speed: asNumber(talkProviderConfig.speed) }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...(trimToUndefined(params.voiceId) == null
        ? {}
        : { voice: trimToUndefined(params.voiceId) }),
      ...(trimToUndefined(params.modelId) == null
        ? {}
        : { model: trimToUndefined(params.modelId) }),
      ...(asNumber(params.speed) == null ? {} : { speed: asNumber(params.speed) }),
    }),
    isConfigured: ({ cfg, providerConfig }) => {
      const config = readMistralProviderConfig(providerConfig, cfg);
      return (
        Boolean(config.apiKey) ||
        Boolean(trimToUndefined(process.env.MISTRAL_API_KEY)) ||
        hasConfiguredSecret(findMistralModelProviderConfig(cfg)?.apiKey) ||
        hasConfiguredMistralAuthProfileMetadata(cfg) ||
        hasConfiguredMistralAuthOrder(cfg)
      );
    },
    synthesizeTelephony: async (req) => {
      const config = readMistralProviderConfig(req.providerConfig, req.cfg);
      const apiKey = await resolveMistralApiKey({
        cfg: req.cfg,
        providerConfig: config,
      });
      // Request WAV instead of PCM because:
      // 1. Mistral's response_format=pcm returns f32le, but the telephony pipeline expects s16le.
      //    Feeding f32le directly caused completely distorted inbound greeting audio.
      // 2. The WAV header is self-describing, so decodeMistralWavToS16le can read the actual
      //    sample rate and bit depth rather than hardcoding assumptions, and handles stereo→mono
      //    mixing. We do the f32le→s16le conversion ourselves to avoid a second lossy step.
      const wavBuffer = await mistralTTS({
        text: req.text,
        apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        voice: config.voice,
        speed: config.speed,
        responseFormat: "wav",
        timeoutMs: req.timeoutMs,
      });
      const { audioBuffer, sampleRate } = decodeMistralWavToS16le(wavBuffer);
      return { audioBuffer, outputFormat: "pcm", sampleRate };
    },
    synthesize: async (req) => {
      const config = readMistralProviderConfig(req.providerConfig, req.cfg);
      const overrides = readMistralOverrides(req.providerOverrides);
      const apiKey = await resolveMistralApiKey({
        cfg: req.cfg,
        providerConfig: config,
      });
      const responseFormat = req.target === "voice-note" ? "opus" : "mp3";
      const audioBuffer = await mistralTTS({
        text: req.text,
        apiKey,
        baseUrl: config.baseUrl,
        model: overrides.model ?? config.model,
        voice: overrides.voice ?? config.voice,
        speed: overrides.speed ?? config.speed,
        responseFormat,
        timeoutMs: req.timeoutMs,
      });
      return {
        audioBuffer,
        outputFormat: responseFormat,
        fileExtension: responseFormat === "opus" ? ".opus" : ".mp3",
        voiceCompatible: req.target === "voice-note",
      };
    },
  };
}
