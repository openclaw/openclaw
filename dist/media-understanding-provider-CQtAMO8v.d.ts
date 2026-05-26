import { f as MediaUnderstandingProvider, n as AudioTranscriptionResult, t as AudioTranscriptionRequest } from "./types-ByzWuf9L.js";
//#region extensions/openai/media-understanding-provider.d.ts
declare function transcribeOpenAiAudio(params: AudioTranscriptionRequest): Promise<AudioTranscriptionResult>;
declare function transcribeOpenAiCodexAudio(params: AudioTranscriptionRequest): Promise<AudioTranscriptionResult>;
declare const openaiMediaUnderstandingProvider: MediaUnderstandingProvider;
declare const openaiCodexMediaUnderstandingProvider: MediaUnderstandingProvider;
//#endregion
export { transcribeOpenAiCodexAudio as i, openaiMediaUnderstandingProvider as n, transcribeOpenAiAudio as r, openaiCodexMediaUnderstandingProvider as t };