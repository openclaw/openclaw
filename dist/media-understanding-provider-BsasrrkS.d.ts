import { f as MediaUnderstandingProvider, n as AudioTranscriptionResult, t as AudioTranscriptionRequest } from "./types-ByzWuf9L.js";
//#region extensions/openrouter/media-understanding-provider.d.ts
declare function transcribeOpenRouterAudio(params: AudioTranscriptionRequest): Promise<AudioTranscriptionResult>;
declare const openrouterMediaUnderstandingProvider: MediaUnderstandingProvider;
//#endregion
export { transcribeOpenRouterAudio as n, openrouterMediaUnderstandingProvider as t };