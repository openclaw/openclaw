import { t as XAI_BASE_URL } from "../../model-definitions-6jK-31b4.js";
//#region extensions/xai/tts.d.ts
declare const XAI_TTS_VOICES: readonly ["eve", "ara", "rex", "sal", "leo", "una"];
type XaiTtsVoice = (typeof XAI_TTS_VOICES)[number];
declare function normalizeXaiTtsBaseUrl(baseUrl?: string): string;
declare function isValidXaiTtsVoice(voice: string, baseUrl?: string): voice is XaiTtsVoice;
declare function normalizeXaiLanguageCode(value: unknown): string | undefined;
declare function xaiTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  voiceId: string;
  language?: string;
  speed?: number;
  responseFormat?: "mp3" | "wav" | "pcm" | "mulaw" | "alaw";
  timeoutMs: number;
}): Promise<Buffer>;
//#endregion
export { XAI_BASE_URL, XAI_TTS_VOICES, isValidXaiTtsVoice, normalizeXaiLanguageCode, normalizeXaiTtsBaseUrl, xaiTTS };