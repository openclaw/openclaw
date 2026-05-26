import { f as MediaUnderstandingProvider, n as AudioTranscriptionResult, t as AudioTranscriptionRequest } from "../../types-ByzWuf9L.js";
//#region extensions/xai/stt.d.ts
declare const XAI_DEFAULT_STT_MODEL = "grok-stt";
declare function transcribeXaiAudio(params: AudioTranscriptionRequest): Promise<AudioTranscriptionResult>;
declare function buildXaiMediaUnderstandingProvider(): MediaUnderstandingProvider;
//#endregion
export { XAI_DEFAULT_STT_MODEL, buildXaiMediaUnderstandingProvider, transcribeXaiAudio };