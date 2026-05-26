import { f as MediaUnderstandingProvider, n as AudioTranscriptionResult, t as AudioTranscriptionRequest } from "./types-ByzWuf9L.js";
//#region extensions/deepinfra/media-understanding-provider.d.ts
declare function transcribeDeepInfraAudio(params: AudioTranscriptionRequest): Promise<AudioTranscriptionResult>;
declare const deepinfraMediaUnderstandingProvider: MediaUnderstandingProvider;
//#endregion
export { transcribeDeepInfraAudio as n, deepinfraMediaUnderstandingProvider as t };