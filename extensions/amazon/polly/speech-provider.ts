import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderPlugin,
  SpeechVoiceOption,
} from "openclaw/plugin-sdk/speech";
import { trimToUndefined } from "openclaw/plugin-sdk/speech";
import { runFfmpeg } from "openclaw/plugin-sdk/media-runtime";
import { pollySynthesize, pollyListVoices } from "./tts.js";

const DEFAULT_VOICE = "Ruth";
const DEFAULT_ENGINE = "generative";
const DEFAULT_REGION = "us-east-1";

const POLLY_ENGINES = ["generative", "neural", "standard", "long-form"] as const;

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

function readPollyConfig(raw: Record<string, unknown>): PollyProviderConfig {
  return {
    enabled: raw.enabled !== false,
    voice: trimToUndefined(raw.voice) ?? DEFAULT_VOICE,
    engine: trimToUndefined(raw.engine) ?? DEFAULT_ENGINE,
    region: trimToUndefined(raw.region) ?? DEFAULT_REGION,
    languageCode: trimToUndefined(raw.languageCode),
    sampleRate: trimToUndefined(raw.sampleRate),
  };
}

/** Parse inline directive tokens like [voice:Joanna] or [engine:neural] from chat messages. */
function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext) {
  const key = ctx.key.toLowerCase();
  switch (key) {
    case "voice":
    case "polly_voice":
    case "pollyvoice":
      if (!ctx.policy.allowVoice) { return { handled: true }; }
      return { handled: true, overrides: { ...ctx.currentOverrides, voice: ctx.value } };
    case "engine":
    case "polly_engine":
    case "pollyengine": {
      if (!ctx.policy.allowModelId) { return { handled: true }; }
      const engine = ctx.value.toLowerCase();
      if (!(POLLY_ENGINES as readonly string[]).includes(engine)) {
        return { handled: true, warnings: [`invalid Polly engine "${ctx.value}" (expected: ${POLLY_ENGINES.join(", ")})`] };
      }
      return { handled: true, overrides: { ...ctx.currentOverrides, engine } };
    }
    case "language":
    case "polly_language":
    case "languagecode":
      return { handled: true, overrides: { ...ctx.currentOverrides, languageCode: ctx.value } };
    default:
      return { handled: false };
  }
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

/**
 * Build the Amazon Polly speech provider.
 * Config is read from the parent `amazon` plugin's `polly` key.
 */
export function buildPollySpeechProvider(pluginConfig?: Record<string, unknown>): SpeechProviderPlugin {
  const pollyConfig = (pluginConfig?.polly ?? {}) as Record<string, unknown>;

  return {
    id: "amazon-polly",
    label: "Amazon Polly",
    aliases: ["polly"],
    autoSelectOrder: 25,

    resolveConfig: ({ rawConfig }) => {
      const raw = (rawConfig as Record<string, unknown>)?.polly ?? rawConfig;
      return readPollyConfig(raw as Record<string, unknown>);
    },

    parseDirectiveToken,

    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = readPollyConfig((baseTtsConfig as Record<string, unknown>)?.polly as Record<string, unknown> ?? baseTtsConfig as Record<string, unknown>);
      return {
        ...base,
        ...(trimToUndefined(talkProviderConfig.voice) == null ? {} : { voice: trimToUndefined(talkProviderConfig.voice)! }),
        ...(trimToUndefined(talkProviderConfig.engine) == null ? {} : { engine: trimToUndefined(talkProviderConfig.engine)! }),
        ...(trimToUndefined(talkProviderConfig.region) == null ? {} : { region: trimToUndefined(talkProviderConfig.region)! }),
        ...(trimToUndefined(talkProviderConfig.languageCode) == null ? {} : { languageCode: trimToUndefined(talkProviderConfig.languageCode) }),
        ...(trimToUndefined(talkProviderConfig.sampleRate) == null ? {} : { sampleRate: trimToUndefined(talkProviderConfig.sampleRate) }),
      };
    },

    resolveTalkOverrides: ({ params }) => ({
      ...(trimToUndefined(params.voice) == null ? {} : { voice: trimToUndefined(params.voice) }),
      ...(trimToUndefined(params.engine) == null ? {} : { engine: trimToUndefined(params.engine) }),
      ...(trimToUndefined(params.region) == null ? {} : { region: trimToUndefined(params.region) }),
      ...(trimToUndefined(params.language) == null ? {} : { languageCode: trimToUndefined(params.language) }),
    }),

    listVoices: async (req) => {
      const config = req.providerConfig
        ? readPollyConfig(req.providerConfig as Record<string, unknown>)
        : readPollyConfig(pollyConfig);
      const voices = await pollyListVoices({
        region: config.region,
        engine: req.providerConfig?.engine as string | undefined,
      });
      return voices.map(
        (v): SpeechVoiceOption => ({
          id: v.id,
          name: `${v.name} (${v.languageName ?? v.languageCode ?? "unknown"}, ${v.gender ?? "unknown"})`,
        }),
      );
    },

    isConfigured: ({ providerConfig }) => {
      const config = readPollyConfig(
        (providerConfig ?? pollyConfig) as Record<string, unknown>,
      );
      return config.enabled;
    },

    synthesize: async (req) => {
      const config = readPollyConfig(
        (req.providerConfig ?? pollyConfig) as Record<string, unknown>,
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

    synthesizeTelephony: async (req) => {
      const config = readPollyConfig(
        (req.providerConfig ?? pollyConfig) as Record<string, unknown>,
      );
      const sampleRate = 22_050;
      const audioBuffer = await pollySynthesize({
        text: req.text,
        voiceId: config.voice,
        engine: config.engine,
        outputFormat: "pcm",
        sampleRate: String(sampleRate),
        languageCode: config.languageCode,
        region: config.region,
        timeoutMs: req.timeoutMs,
      });
      return { audioBuffer, outputFormat: "pcm", sampleRate };
    },
  };
}
