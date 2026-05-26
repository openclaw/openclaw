import { n as AudioTranscriptionResult, t as AudioTranscriptionRequest } from "../../types-ByzWuf9L.js";
//#region extensions/deepgram/audio.d.ts
declare const DEFAULT_DEEPGRAM_AUDIO_BASE_URL = "https://api.deepgram.com/v1";
declare const DEFAULT_DEEPGRAM_AUDIO_MODEL = "nova-3";
declare function transcribeDeepgramAudio(params: AudioTranscriptionRequest): Promise<AudioTranscriptionResult>;
//#endregion
export { DEFAULT_DEEPGRAM_AUDIO_BASE_URL, DEFAULT_DEEPGRAM_AUDIO_MODEL, transcribeDeepgramAudio };