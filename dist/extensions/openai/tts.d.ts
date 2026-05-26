//#region extensions/openai/tts.d.ts
declare const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
declare const OPENAI_TTS_MODELS: readonly ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"];
declare const OPENAI_TTS_VOICES: readonly ["alloy", "ash", "ballad", "cedar", "coral", "echo", "fable", "juniper", "marin", "onyx", "nova", "sage", "shimmer", "verse"];
type OpenAiTtsVoice = (typeof OPENAI_TTS_VOICES)[number];
declare function normalizeOpenAITtsBaseUrl(baseUrl?: string): string;
declare function isValidOpenAIModel(model: string, baseUrl?: string): boolean;
declare function isValidOpenAIVoice(voice: string, baseUrl?: string): voice is OpenAiTtsVoice;
declare function resolveOpenAITtsInstructions(model: string, instructions?: string, baseUrl?: string): string | undefined;
declare function openaiTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
  speed?: number;
  instructions?: string;
  responseFormat: "mp3" | "opus" | "pcm" | "wav";
  extraBody?: Record<string, unknown>;
  timeoutMs: number;
}): Promise<Buffer>;
//#endregion
export { DEFAULT_OPENAI_BASE_URL, OPENAI_TTS_MODELS, OPENAI_TTS_VOICES, isValidOpenAIModel, isValidOpenAIVoice, normalizeOpenAITtsBaseUrl, openaiTTS, resolveOpenAITtsInstructions };