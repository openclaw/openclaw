import { L as SpeechVoiceOption } from "../../tts-runtime.types-DsGX4LDs.js";
//#region extensions/inworld/tts.d.ts
declare const DEFAULT_INWORLD_VOICE_ID = "Sarah";
declare const DEFAULT_INWORLD_MODEL_ID = "inworld-tts-1.5-max";
declare const INWORLD_TTS_MODELS: readonly ["inworld-tts-1.5-max", "inworld-tts-1.5-mini", "inworld-tts-1-max", "inworld-tts-1"];
type InworldAudioEncoding = "MP3" | "OGG_OPUS" | "LINEAR16" | "PCM" | "WAV" | "ALAW" | "MULAW" | "FLAC";
declare function normalizeInworldBaseUrl(baseUrl?: string): string;
/**
 * Calls the Inworld streaming TTS endpoint and concatenates every audio chunk
 * into a single buffer. The stream returns newline-delimited JSON, each line
 * carrying base64 audio in `result.audioContent`.
 */
declare function inworldTTS(params: {
  text: string;
  apiKey: string;
  baseUrl?: string;
  voiceId?: string;
  modelId?: string;
  audioEncoding?: InworldAudioEncoding;
  sampleRateHertz?: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<Buffer>;
declare function listInworldVoices(params: {
  apiKey: string;
  baseUrl?: string;
  language?: string;
  timeoutMs?: number;
}): Promise<SpeechVoiceOption[]>;
//#endregion
export { DEFAULT_INWORLD_MODEL_ID, DEFAULT_INWORLD_VOICE_ID, INWORLD_TTS_MODELS, InworldAudioEncoding, inworldTTS, listInworldVoices, normalizeInworldBaseUrl };