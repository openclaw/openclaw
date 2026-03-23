import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/core";
import { elevenLabsTTS, type SpeechVoiceOption } from "openclaw/plugin-sdk/speech-core";

const ELEVENLABS_TTS_MODELS = [
  "eleven_multilingual_v2",
  "eleven_turbo_v2_5",
  "eleven_monolingual_v1",
] as const;

function normalizeElevenLabsBaseUrl(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim();
  return trimmed?.replace(/\/+$/, "") || "https://api.elevenlabs.io";
}

export async function listElevenLabsVoices(params: {
  apiKey: string;
  baseUrl?: string;
}): Promise<SpeechVoiceOption[]> {
  const res = await fetch(`${normalizeElevenLabsBaseUrl(params.baseUrl)}/v1/voices`, {
    headers: {
      "xi-api-key": params.apiKey,
    },
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs voices API error (${res.status})`);
  }
  const json = (await res.json()) as {
    voices?: Array<{
      voice_id?: string;
      name?: string;
      category?: string;
      description?: string;
    }>;
  };
  return Array.isArray(json.voices)
    ? json.voices
        .map((voice) => ({
          id: voice.voice_id?.trim() ?? "",
          name: voice.name?.trim() || undefined,
          category: voice.category?.trim() || undefined,
          description: voice.description?.trim() || undefined,
        }))
        .filter((voice) => voice.id.length > 0)
    : [];
}

export function buildElevenLabsSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "elevenlabs",
    label: "ElevenLabs",
    models: ELEVENLABS_TTS_MODELS,
    listVoices: async (req) => {
      const apiKey =
        req.apiKey ||
        req.config?.elevenlabs.apiKey ||
        process.env.ELEVENLABS_API_KEY ||
        process.env.XI_API_KEY;
      if (!apiKey) {
        throw new Error("ElevenLabs API key missing");
      }
      return listElevenLabsVoices({
        apiKey,
        baseUrl: req.baseUrl ?? req.config?.elevenlabs.baseUrl,
      });
    },
    isConfigured: ({ config }) =>
      Boolean(config.elevenlabs.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY),
    synthesize: async (req) => {
      const apiKey =
        req.config.elevenlabs.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
      if (!apiKey) {
        throw new Error("ElevenLabs API key missing");
      }
      const outputFormat =
        req.overrides?.elevenlabs?.outputFormat ??
        (req.target === "voice-note" ? "opus_48000_64" : "mp3_44100_128");
      const audioBuffer = await elevenLabsTTS({
        text: req.text,
        apiKey,
        baseUrl: req.config.elevenlabs.baseUrl,
        voiceId: req.overrides?.elevenlabs?.voiceId ?? req.config.elevenlabs.voiceId,
        modelId: req.overrides?.elevenlabs?.modelId ?? req.config.elevenlabs.modelId,
        outputFormat,
        seed: req.overrides?.elevenlabs?.seed ?? req.config.elevenlabs.seed,
        applyTextNormalization:
          req.overrides?.elevenlabs?.applyTextNormalization ??
          req.config.elevenlabs.applyTextNormalization,
        languageCode: req.overrides?.elevenlabs?.languageCode ?? req.config.elevenlabs.languageCode,
        voiceSettings: {
          ...req.config.elevenlabs.voiceSettings,
          ...req.overrides?.elevenlabs?.voiceSettings,
        },
        timeoutMs: req.config.timeoutMs,
      });
      return {
        audioBuffer,
        outputFormat,
        fileExtension: req.target === "voice-note" ? ".opus" : ".mp3",
        voiceCompatible: req.target === "voice-note",
      };
    },
    synthesizeTelephony: async (req) => {
      const apiKey =
        req.config.elevenlabs.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
      if (!apiKey) {
        throw new Error("ElevenLabs API key missing");
      }
      const outputFormat = "pcm_22050";
      const sampleRate = 22_050;
      const audioBuffer = await elevenLabsTTS({
        text: req.text,
        apiKey,
        baseUrl: req.config.elevenlabs.baseUrl,
        voiceId: req.config.elevenlabs.voiceId,
        modelId: req.config.elevenlabs.modelId,
        outputFormat,
        seed: req.config.elevenlabs.seed,
        applyTextNormalization: req.config.elevenlabs.applyTextNormalization,
        languageCode: req.config.elevenlabs.languageCode,
        voiceSettings: req.config.elevenlabs.voiceSettings,
        timeoutMs: req.config.timeoutMs,
      });
      return { audioBuffer, outputFormat, sampleRate };
    },
  };
}
