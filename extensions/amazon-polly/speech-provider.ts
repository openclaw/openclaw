import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech";
import { trimToUndefined } from "openclaw/plugin-sdk/speech";
import { runFfmpeg } from "openclaw/plugin-sdk/media-runtime";
import { pollySynthesize } from "./tts.js";

const DEFAULT_VOICE = "Ruth";
const DEFAULT_ENGINE = "generative";
const DEFAULT_REGION = "us-east-1";

type PollyProviderConfig = {
  enabled: boolean;
  voice: string;
  engine: string;
  region: string;
  languageCode?: string;
  sampleRate?: string;
};

/** Default sample rate per engine. Generative/long-form support 24000; standard/neural require ≤22050. */
function defaultSampleRate(engine: string): string {
  return engine === "generative" || engine === "long-form" ? "24000" : "22050";
}

function readPollyProviderConfig(raw: Record<string, unknown>): PollyProviderConfig {
  return {
    enabled: raw.enabled !== false,
    voice: trimToUndefined(raw.voice) ?? DEFAULT_VOICE,
    engine: trimToUndefined(raw.engine) ?? DEFAULT_ENGINE,
    region: trimToUndefined(raw.region) ?? DEFAULT_REGION,
    languageCode: trimToUndefined(raw.languageCode),
    sampleRate: trimToUndefined(raw.sampleRate),
  };
}

/**
 * Convert MP3 audio to Opus-in-OGG for WhatsApp voice note compatibility.
 */
async function convertToOpusOgg(inputBuffer: Buffer): Promise<Buffer> {
  const tmpDir = os.tmpdir();
  const id = `polly-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inputPath = path.join(tmpDir, `${id}.mp3`);
  const outputPath = path.join(tmpDir, `${id}.ogg`);

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

    isConfigured: ({ providerConfig }) => {
      const config = readPollyProviderConfig(
        (providerConfig ?? {}) as Record<string, unknown>,
      );
      return config.enabled;
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

      const audioBuffer = await pollySynthesize({
        text: req.text,
        voiceId: voice,
        engine,
        outputFormat: "mp3",
        sampleRate: sampleRate ?? defaultSampleRate(engine),
        languageCode,
        region,
        timeoutMs: req.timeoutMs,
      });

      if (req.target === "voice-note") {
        const opusBuffer = await convertToOpusOgg(audioBuffer);
        return {
          audioBuffer: opusBuffer,
          outputFormat: "ogg_opus",
          fileExtension: ".ogg",
          voiceCompatible: true,
        };
      }

      return {
        audioBuffer,
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      };
    },
  };
}
