import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/core";
import { OPENAI_TTS_MODELS, OPENAI_TTS_VOICES, openaiTTS } from "./tts.js";

export function buildOpenAISpeechProvider(): SpeechProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    models: OPENAI_TTS_MODELS,
    voices: OPENAI_TTS_VOICES,
    listVoices: async () => OPENAI_TTS_VOICES.map((voice) => ({ id: voice, name: voice })),
    isConfigured: ({ config }) => Boolean(config.openai.apiKey || process.env.OPENAI_API_KEY),
    synthesize: async (req) => {
      const apiKey = req.config.openai.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OpenAI API key missing");
      }
      const responseFormat = req.target === "voice-note" ? "opus" : "mp3";
      const audioBuffer = await openaiTTS({
        text: req.text,
        apiKey,
        baseUrl: req.config.openai.baseUrl,
        model: req.overrides?.openai?.model ?? req.config.openai.model,
        voice: req.overrides?.openai?.voice ?? req.config.openai.voice,
        speed: req.overrides?.openai?.speed ?? req.config.openai.speed,
        instructions: req.config.openai.instructions,
        responseFormat,
        timeoutMs: req.config.timeoutMs,
      });
      return {
        audioBuffer,
        outputFormat: responseFormat,
        fileExtension: responseFormat === "opus" ? ".opus" : ".mp3",
        voiceCompatible: req.target === "voice-note",
      };
    },
    synthesizeTelephony: async (req) => {
      const apiKey = req.config.openai.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OpenAI API key missing");
      }
      const outputFormat = "pcm";
      const sampleRate = 24_000;
      const audioBuffer = await openaiTTS({
        text: req.text,
        apiKey,
        baseUrl: req.config.openai.baseUrl,
        model: req.config.openai.model,
        voice: req.config.openai.voice,
        speed: req.config.openai.speed,
        instructions: req.config.openai.instructions,
        responseFormat: outputFormat,
        timeoutMs: req.config.timeoutMs,
      });
      return { audioBuffer, outputFormat, sampleRate };
    },
  };
}
