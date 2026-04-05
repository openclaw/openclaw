import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runFfmpeg } from "openclaw/plugin-sdk/media-runtime";
import type {
  SpeechProviderConfig,
  SpeechProviderPlugin,
  SpeechVoiceOption,
} from "openclaw/plugin-sdk/speech";
import { asObject, trimToUndefined } from "openclaw/plugin-sdk/speech";
import { pollyListVoices, pollySynthesize } from "./tts.js";

const DEFAULT_POLLY_REGION = "us-east-1";
const DEFAULT_POLLY_VOICE = "Joanna";
const DEFAULT_POLLY_ENGINE = "neural";

type PollyProviderConfig = {
  enabled: boolean;
  region: string;
  voice: string;
  engine: string;
  languageCode?: string;
  sampleRate?: string;
};

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizePollyProviderConfig(rawConfig: Record<string, unknown>): PollyProviderConfig {
  const providers = asObject(rawConfig.providers);
  const rawPolly =
    asObject(providers?.["amazon-polly"]) ??
    asObject(providers?.polly) ??
    asObject(rawConfig["amazon-polly"]) ??
    asObject(rawConfig.polly);
  const raw = rawPolly ?? {};
  return {
    enabled: asBoolean(raw.enabled) ?? true,
    region:
      trimToUndefined(raw.region) ??
      trimToUndefined(process.env.AWS_REGION) ??
      trimToUndefined(process.env.AWS_DEFAULT_REGION) ??
      DEFAULT_POLLY_REGION,
    voice: trimToUndefined(raw.voice) ?? DEFAULT_POLLY_VOICE,
    engine: trimToUndefined(raw.engine) ?? DEFAULT_POLLY_ENGINE,
    languageCode: trimToUndefined(raw.languageCode),
    sampleRate: trimToUndefined(raw.sampleRate),
  };
}

function readPollyProviderConfig(config: SpeechProviderConfig): PollyProviderConfig {
  const defaults = normalizePollyProviderConfig({});
  return {
    enabled: asBoolean(config.enabled) ?? defaults.enabled,
    region: trimToUndefined(config.region) ?? defaults.region,
    voice: trimToUndefined(config.voice) ?? defaults.voice,
    engine: trimToUndefined(config.engine) ?? defaults.engine,
    languageCode: trimToUndefined(config.languageCode) ?? defaults.languageCode,
    sampleRate: trimToUndefined(config.sampleRate) ?? defaults.sampleRate,
  };
}

function isAwsCredentialsAvailable(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID ||
    process.env.AWS_PROFILE ||
    process.env.AWS_ROLE_ARN ||
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
    process.env.ECS_CONTAINER_METADATA_URI,
  );
}

/**
 * Transcode Polly ogg_vorbis output to Opus in OGG container for WhatsApp voice-note compatibility.
 * Polly's ogg_vorbis uses Vorbis codec, but WhatsApp requires Opus codec.
 */
async function transcodeToOpus(vorbisBuffer: Buffer): Promise<Buffer> {
  const id = crypto.randomUUID();
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `polly-vorbis-${id}.ogg`);
  const outputPath = path.join(tmpDir, `polly-opus-${id}.ogg`);

  try {
    await fs.writeFile(inputPath, vorbisBuffer);
    await runFfmpeg([
      "-i",
      inputPath,
      "-c:a",
      "libopus",
      "-b:a",
      "64k",
      "-ar",
      "48000",
      outputPath,
    ]);
    return await fs.readFile(outputPath);
  } finally {
    await Promise.allSettled([fs.unlink(inputPath), fs.unlink(outputPath)]);
  }
}

/**
 * Build the Amazon Polly speech provider plugin.
 * @returns A configured SpeechProviderPlugin for Amazon Polly TTS.
 */
export function buildPollySpeechProvider(): SpeechProviderPlugin {
  return {
    id: "amazon-polly",
    label: "Amazon Polly",
    aliases: ["polly"],
    autoSelectOrder: 25,
    resolveConfig: ({ rawConfig }) => normalizePollyProviderConfig(rawConfig),
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizePollyProviderConfig(baseTtsConfig);
      return {
        ...base,
        enabled: true,
        ...(trimToUndefined(talkProviderConfig.voiceId) == null
          ? {}
          : { voice: trimToUndefined(talkProviderConfig.voiceId) }),
        ...(trimToUndefined(talkProviderConfig.languageCode) == null
          ? {}
          : { languageCode: trimToUndefined(talkProviderConfig.languageCode) }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...(trimToUndefined(params.voiceId) == null
        ? {}
        : { voice: trimToUndefined(params.voiceId) }),
      ...(trimToUndefined(params.engine) == null ? {} : { engine: trimToUndefined(params.engine) }),
    }),
    listVoices: async (req) => {
      const config = req.providerConfig
        ? readPollyProviderConfig(req.providerConfig)
        : normalizePollyProviderConfig({});
      const voices = await pollyListVoices({
        region: config.region,
        engine: config.engine,
      });
      return voices.map(
        (voice): SpeechVoiceOption => ({
          id: voice.id,
          name: voice.name,
          gender: voice.gender,
          locale: voice.languageCode ?? undefined,
          description: voice.languageName ?? undefined,
        }),
      );
    },
    isConfigured: ({ providerConfig }) => {
      const config = readPollyProviderConfig(providerConfig);
      return config.enabled && isAwsCredentialsAvailable();
    },
    synthesize: async (req) => {
      const config = readPollyProviderConfig(req.providerConfig);
      const overrides = req.providerOverrides ?? {};
      const voice = trimToUndefined(overrides.voice) ?? config.voice;
      const engine = trimToUndefined(overrides.engine) ?? config.engine;

      const isVoiceNote = req.target === "voice-note";
      const outputFormat = isVoiceNote ? "ogg_vorbis" : "mp3";

      const audioBuffer = await pollySynthesize({
        text: req.text,
        voiceId: voice,
        engine,
        outputFormat,
        sampleRate: config.sampleRate,
        languageCode: config.languageCode,
        region: config.region,
        timeoutMs: req.timeoutMs,
      });

      if (isVoiceNote) {
        // Polly ogg_vorbis uses Vorbis codec; WhatsApp needs Opus in OGG.
        const opusBuffer = await transcodeToOpus(audioBuffer);
        return {
          audioBuffer: opusBuffer,
          outputFormat: "ogg_vorbis",
          fileExtension: ".ogg",
          voiceCompatible: true,
        };
      }

      return {
        audioBuffer,
        outputFormat,
        fileExtension: ".mp3",
        voiceCompatible: false,
      };
    },
  };
}
