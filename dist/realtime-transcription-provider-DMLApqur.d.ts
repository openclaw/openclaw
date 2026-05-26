import { Jr as RealtimeTranscriptionProviderConfig, Rn as RealtimeTranscriptionProviderPlugin, ei as RealtimeTranscriptionSessionCreateRequest } from "./types-lCXG2pW_.js";
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
declare const __testing: {
  normalizeProviderConfig: typeof normalizeProviderConfig;
  toDeepgramRealtimeWsUrl: typeof toDeepgramRealtimeWsUrl;
};
//#endregion
export { buildDeepgramRealtimeTranscriptionProvider as n, __testing as t };