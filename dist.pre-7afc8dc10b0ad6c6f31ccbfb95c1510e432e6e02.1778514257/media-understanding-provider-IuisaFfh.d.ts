import { f as MediaUnderstandingProvider, m as VideoDescriptionResult, n as AudioTranscriptionResult, p as VideoDescriptionRequest, t as AudioTranscriptionRequest } from "./types-Bww3J3ev.js";
//#region extensions/google/media-understanding-provider.d.ts
declare const DEFAULT_GOOGLE_AUDIO_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
declare const DEFAULT_GOOGLE_VIDEO_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
declare function transcribeGeminiAudio(params: AudioTranscriptionRequest): Promise<AudioTranscriptionResult>;
declare function describeGeminiVideo(params: VideoDescriptionRequest): Promise<VideoDescriptionResult>;
declare const googleMediaUnderstandingProvider: MediaUnderstandingProvider;
//#endregion
export { transcribeGeminiAudio as a, googleMediaUnderstandingProvider as i, DEFAULT_GOOGLE_VIDEO_BASE_URL as n, describeGeminiVideo as r, DEFAULT_GOOGLE_AUDIO_BASE_URL as t };