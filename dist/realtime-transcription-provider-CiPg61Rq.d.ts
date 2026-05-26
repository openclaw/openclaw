import { $r as RealtimeTranscriptionProviderConfig, Un as RealtimeTranscriptionProviderPlugin, ai as RealtimeTranscriptionSessionCreateRequest } from "./types-Vx7Jq4_-2.js";
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
declare const testing: {
  normalizeProviderConfig: typeof normalizeProviderConfig;
  toMistralRealtimeWsUrl: typeof toMistralRealtimeWsUrl;
};
//#endregion
export { testing as n, buildMistralRealtimeTranscriptionProvider as t };