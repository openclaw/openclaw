import { f as MediaUnderstandingProvider, n as AudioTranscriptionResult, t as AudioTranscriptionRequest, v as VideoDescriptionRequest, y as VideoDescriptionResult } from "./types-ByzWuf9L.js";
//#region extensions/google/media-understanding-provider.d.ts
declare const DEFAULT_GOOGLE_AUDIO_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
declare const DEFAULT_GOOGLE_VIDEO_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
declare function transcribeGeminiAudio(params: AudioTranscriptionRequest): Promise<AudioTranscriptionResult>;
declare function describeGeminiVideo(params: VideoDescriptionRequest): Promise<VideoDescriptionResult>;
declare const googleMediaUnderstandingProvider: MediaUnderstandingProvider;
//#endregion
export { transcribeGeminiAudio as a, googleMediaUnderstandingProvider as i, DEFAULT_GOOGLE_VIDEO_BASE_URL as n, describeGeminiVideo as r, DEFAULT_GOOGLE_AUDIO_BASE_URL as t };