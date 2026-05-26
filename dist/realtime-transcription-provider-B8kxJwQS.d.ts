import { Jr as RealtimeTranscriptionProviderConfig, Rn as RealtimeTranscriptionProviderPlugin, ei as RealtimeTranscriptionSessionCreateRequest } from "./types-lCXG2pW_.js";
//#region extensions/elevenlabs/realtime-transcription-provider.d.ts
type ElevenLabsRealtimeTranscriptionProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  modelId?: string;
  audioFormat?: string;
  sampleRate?: number;
  languageCode?: string;
  commitStrategy?: "manual" | "vad";
  vadSilenceThresholdSecs?: number;
  vadThreshold?: number;
  minSpeechDurationMs?: number;
  minSilenceDurationMs?: number;
};
type ElevenLabsRealtimeTranscriptionSessionConfig = RealtimeTranscriptionSessionCreateRequest & {
  apiKey: string;
  baseUrl: string;
  modelId: string;
  audioFormat: string;
  sampleRate: number;
  commitStrategy: "manual" | "vad";
  languageCode?: string;
  vadSilenceThresholdSecs?: number;
  vadThreshold?: number;
  minSpeechDurationMs?: number;
  minSilenceDurationMs?: number;
};
declare function normalizeProviderConfig(config: RealtimeTranscriptionProviderConfig): ElevenLabsRealtimeTranscriptionProviderConfig;
declare function toElevenLabsRealtimeWsUrl(config: ElevenLabsRealtimeTranscriptionSessionConfig): string;
declare function buildElevenLabsRealtimeTranscriptionProvider(): RealtimeTranscriptionProviderPlugin;
declare const __testing: {
  normalizeProviderConfig: typeof normalizeProviderConfig;
  toElevenLabsRealtimeWsUrl: typeof toElevenLabsRealtimeWsUrl;
};
//#endregion
export { buildElevenLabsRealtimeTranscriptionProvider as n, __testing as t };