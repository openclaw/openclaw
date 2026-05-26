import { Jr as RealtimeTranscriptionProviderConfig, Rn as RealtimeTranscriptionProviderPlugin, ei as RealtimeTranscriptionSessionCreateRequest } from "./types-lCXG2pW_.js";
//#region extensions/mistral/realtime-transcription-provider.d.ts
type MistralRealtimeTranscriptionEncoding = "pcm_s16le" | "pcm_s32le" | "pcm_f16le" | "pcm_f32le" | "pcm_mulaw" | "pcm_alaw";
type MistralRealtimeTranscriptionProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  sampleRate?: number;
  encoding?: MistralRealtimeTranscriptionEncoding;
  targetStreamingDelayMs?: number;
};
type MistralRealtimeTranscriptionSessionConfig = RealtimeTranscriptionSessionCreateRequest & {
  apiKey: string;
  baseUrl: string;
  model: string;
  sampleRate: number;
  encoding: MistralRealtimeTranscriptionEncoding;
  targetStreamingDelayMs?: number;
};
declare function toMistralRealtimeWsUrl(config: MistralRealtimeTranscriptionSessionConfig): string;
declare function normalizeProviderConfig(config: RealtimeTranscriptionProviderConfig): MistralRealtimeTranscriptionProviderConfig;
declare function buildMistralRealtimeTranscriptionProvider(): RealtimeTranscriptionProviderPlugin;
declare const __testing: {
  normalizeProviderConfig: typeof normalizeProviderConfig;
  toMistralRealtimeWsUrl: typeof toMistralRealtimeWsUrl;
};
//#endregion
export { buildMistralRealtimeTranscriptionProvider as n, __testing as t };