import { f as MediaUnderstandingProvider, n as AudioTranscriptionResult, t as AudioTranscriptionRequest } from "./types-ByzWuf9L.js";
//#region extensions/elevenlabs/media-understanding-provider.d.ts
declare function transcribeElevenLabsAudio(req: AudioTranscriptionRequest): Promise<AudioTranscriptionResult>;
declare const elevenLabsMediaUnderstandingProvider: MediaUnderstandingProvider;
//#endregion
export { transcribeElevenLabsAudio as n, elevenLabsMediaUnderstandingProvider as t };