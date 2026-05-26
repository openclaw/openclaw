import { L as SpeechVoiceOption } from "../../tts-runtime.types-DsGX4LDs.js";
//#region extensions/azure-speech/tts.d.ts
declare const DEFAULT_AZURE_SPEECH_VOICE = "en-US-JennyNeural";
declare const DEFAULT_AZURE_SPEECH_LANG = "en-US";
declare const DEFAULT_AZURE_SPEECH_AUDIO_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
declare const DEFAULT_AZURE_SPEECH_VOICE_NOTE_FORMAT = "ogg-24khz-16bit-mono-opus";
declare const DEFAULT_AZURE_SPEECH_TELEPHONY_FORMAT = "raw-8khz-8bit-mono-mulaw";
declare function normalizeAzureSpeechBaseUrl(params: {
  baseUrl?: string;
  endpoint?: string;
  region?: string;
}): string | undefined;
declare function buildAzureSpeechSsml(params: {
  text: string;
  voice: string;
  lang?: string;
}): string;
declare function inferAzureSpeechFileExtension(outputFormat: string): string;
declare function isAzureSpeechVoiceCompatible(outputFormat: string): boolean;
declare function listAzureSpeechVoices(params: {
  apiKey: string;
  baseUrl?: string;
  endpoint?: string;
  region?: string;
  timeoutMs?: number;
}): Promise<SpeechVoiceOption[]>;
declare function azureSpeechTTS(params: {
  text: string;
  apiKey: string;
  baseUrl?: string;
  endpoint?: string;
  region?: string;
  voice?: string;
  lang?: string;
  outputFormat?: string;
  timeoutMs?: number;
}): Promise<Buffer>;
//#endregion
export { DEFAULT_AZURE_SPEECH_AUDIO_FORMAT, DEFAULT_AZURE_SPEECH_LANG, DEFAULT_AZURE_SPEECH_TELEPHONY_FORMAT, DEFAULT_AZURE_SPEECH_VOICE, DEFAULT_AZURE_SPEECH_VOICE_NOTE_FORMAT, azureSpeechTTS, buildAzureSpeechSsml, inferAzureSpeechFileExtension, isAzureSpeechVoiceCompatible, listAzureSpeechVoices, normalizeAzureSpeechBaseUrl };