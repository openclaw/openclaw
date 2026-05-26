import { $r as RealtimeTranscriptionProviderConfig, Un as RealtimeTranscriptionProviderPlugin, ai as RealtimeTranscriptionSessionCreateRequest } from "./types-Vx7Jq4_-2.js";
//#region extensions/deepgram/realtime-transcription-provider.d.ts
type DeepgramRealtimeTranscriptionEncoding = "linear16" | "mulaw" | "alaw";
type DeepgramRealtimeTranscriptionProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  language?: string;
  sampleRate?: number;
  encoding?: DeepgramRealtimeTranscriptionEncoding;
  interimResults?: boolean;
  endpointingMs?: number;
};
type DeepgramRealtimeTranscriptionSessionConfig = RealtimeTranscriptionSessionCreateRequest & {
  apiKey: string;
  baseUrl: string;
  model: string;
  sampleRate: number;
  encoding: DeepgramRealtimeTranscriptionEncoding;
  interimResults: boolean;
  endpointingMs: number;
  language?: string;
};
declare function toDeepgramRealtimeWsUrl(config: DeepgramRealtimeTranscriptionSessionConfig): string;
declare function normalizeProviderConfig(config: RealtimeTranscriptionProviderConfig): DeepgramRealtimeTranscriptionProviderConfig;
declare function buildDeepgramRealtimeTranscriptionProvider(): RealtimeTranscriptionProviderPlugin;
declare const testing: {
  normalizeProviderConfig: typeof normalizeProviderConfig;
  toDeepgramRealtimeWsUrl: typeof toDeepgramRealtimeWsUrl;
};
//#endregion
export { testing as n, buildDeepgramRealtimeTranscriptionProvider as t };