import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  SpeechProviderPlugin,
  SpeechVoiceOption,
} from "openclaw/plugin-sdk/speech";
import { runFfmpeg } from "openclaw/plugin-sdk/media-runtime";
import { pollySynthesize, pollyListVoices, hasAwsCredentials } from "./tts.js";

const DEFAULT_VOICE = "Ruth";
const DEFAULT_ENGINE = "generative";
const DEFAULT_REGION = "us-east-1";
const DEFAULT_LANGUAGE_CODE = "en-US";

type PollyProviderConfig = {
  enabled: boolean;
  voice: string;
  engine: string;
  region: string;
  languageCode?: string;
  sampleRate?: string;
};

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPollyProviderConfig(raw: Record<string, unknown>): PollyProviderConfig {
  // Support both flat config and nested providers.amazon-polly config
  const nested =
    (raw.providers as Record<string, unknown> | undefined)?.["amazon-polly"] as
      | Record<string, unknown>
      | undefined;
  const source = nested ?? raw;

  return {
    enabled: source.enabled !== false,
    voice: trimToUndefined(source.voice) ?? DEFAULT_VOICE,
    engine: trimToUndefined(source.engine) ?? DEFAULT_ENGINE,
    region: trimToUndefined(source.region) ?? DEFAULT_REGION,
    languageCode: trimToUndefined(source.languageCode),
    sampleRate: trimToUndefined(source.sampleRate),
  };
}

/**
 * Convert PCM/MP3/Vorbis audio to Opus-in-OGG for WhatsApp voice note compatibility.
 * WhatsApp requires Opus codec in OGG container.
 */
async function convertToOpusOgg(inputBuffer: Buffer, timeoutMs: number): Promise<Buffer> {
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `polly-input-${Date.now()}.mp3`);
  const outputPath = path.join(tmpDir, `polly-output-${Date.now()}.ogg`);

  try {
    await fs.writeFile(inputPath, inputBuffer);
    await runFfmpeg([
      "-i", inputPath,
      "-c:a", "libopus",
      "-b:a", "64k",
      "-ar", "48000",
      "-ac", "1",
      "-application", "voip",
      "-y", outputPath,
    ]);
    return await fs.readFile(outputPath);
  } finally {
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
  }
}

export function buildPollySpeechProvider(): SpeechProviderPlugin {
  return {
    id: "amazon-polly",
    label: "Amazon Polly",
    aliases: ["polly"],
    autoSelectOrder: 25,

    resolveConfig: ({ rawConfig }) => readPollyProviderConfig(rawConfig as Record<string, unknown>),

    listVoices: async (req) => {
      const config = req.providerConfig
        ? readPollyProviderConfig(req.providerConfig as Record<string, unknown>)
        : { region: DEFAULT_REGION };
      const voices = await pollyListVoices({
        region: config.region,
        engine: req.providerConfig?.engine as string | undefined,
      });
      return voices.map(
        (v): SpeechVoiceOption => ({
          id: v.id,
          label: `${v.name} (${v.languageName ?? v.languageCode ?? "unknown"}, ${v.gender ?? "unknown"})`,
        }),
      );
    },

    isConfigured: ({ providerConfig }) => {
      const config = readPollyProviderConfig(
        (providerConfig ?? {}) as Record<string, unknown>,
      );
      if (!config.enabled) {
        return false;
      }
      // If explicitly enabled in config, trust that credentials are available
      // (instance roles / ECS task roles don't set env vars).
      // Otherwise, check for env-var-based credentials.
      return config.enabled || hasAwsCredentials();
    },

    synthesize: async (req) => {
      const config = readPollyProviderConfig(
        (req.providerConfig ?? {}) as Record<string, unknown>,
      );
      const overrides = (req.providerOverrides ?? {}) as Record<string, unknown>;

      const voice = trimToUndefined(overrides.voice) ?? config.voice;
      const engine = trimToUndefined(overrides.engine) ?? config.engine;
      const region = trimToUndefined(overrides.region) ?? config.region;
      const languageCode = trimToUndefined(overrides.languageCode) ?? config.languageCode;
      const sampleRate = trimToUndefined(overrides.sampleRate) ?? config.sampleRate;

      if (req.target === "voice-note") {
        // For voice notes (WhatsApp etc): synthesize MP3, then convert to Opus/OGG
        const mp3Buffer = await pollySynthesize({
          text: req.text,
          voiceId: voice,
          engine,
          outputFormat: "mp3",
          sampleRate: sampleRate ?? "24000",
          languageCode,
          region,
          timeoutMs: req.timeoutMs,
        });

        const opusBuffer = await convertToOpusOgg(mp3Buffer, req.timeoutMs);

        return {
          audioBuffer: opusBuffer,
          outputFormat: "ogg_vorbis",
          fileExtension: ".ogg",
          voiceCompatible: true,
        };
      }

      // Default: MP3 audio file
      const audioBuffer = await pollySynthesize({
        text: req.text,
        voiceId: voice,
        engine,
        outputFormat: "mp3",
        sampleRate: sampleRate ?? "24000",
        languageCode,
        region,
        timeoutMs: req.timeoutMs,
      });

      return {
        audioBuffer,
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      };
    },
  };
}
