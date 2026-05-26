import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { Un as RealtimeTranscriptionProviderPlugin, ii as RealtimeTranscriptionSessionCallbacks, ri as RealtimeTranscriptionSession, ti as RealtimeTranscriptionProviderId } from "./types-Vx7Jq4_-2.js";

//#region src/realtime-transcription/provider-registry.d.ts
declare function normalizeRealtimeTranscriptionProviderId(providerId: string | undefined): RealtimeTranscriptionProviderId | undefined;
declare function listRealtimeTranscriptionProviders(cfg?: OpenClawConfig): RealtimeTranscriptionProviderPlugin[];
declare function getRealtimeTranscriptionProvider(providerId: string | undefined, cfg?: OpenClawConfig): RealtimeTranscriptionProviderPlugin | undefined;
declare function canonicalizeRealtimeTranscriptionProviderId(providerId: string | undefined, cfg?: OpenClawConfig): RealtimeTranscriptionProviderId | undefined;
//#endregion
//#region src/realtime-transcription/websocket-session.d.ts
type RealtimeTranscriptionWebSocketTransport = {
  readonly callbacks: RealtimeTranscriptionSessionCallbacks;
  closeNow(): void;
  failConnect(error: Error): void;
  isOpen(): boolean;
  isReady(): boolean;
  markReady(): void;
  sendBinary(payload: Buffer): boolean;
  sendJson(payload: unknown): boolean;
};
type RealtimeTranscriptionWebSocketSessionOptions<Event = unknown> = {
  callbacks: RealtimeTranscriptionSessionCallbacks;
  connectClosedBeforeReadyMessage?: string;
  connectTimeoutMessage?: string;
  connectTimeoutMs?: number;
  closeTimeoutMs?: number;
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  maxQueuedBytes?: number;
  maxReconnectAttempts?: number;
  onClose?: (transport: RealtimeTranscriptionWebSocketTransport) => void;
  onMessage?: (event: Event, transport: RealtimeTranscriptionWebSocketTransport) => void;
  onOpen?: (transport: RealtimeTranscriptionWebSocketTransport) => void;
  parseMessage?: (payload: Buffer) => Event;
  providerId: string;
  readyOnOpen?: boolean;
  reconnectDelayMs?: number;
  reconnectLimitMessage?: string;
  sendAudio: (audio: Buffer, transport: RealtimeTranscriptionWebSocketTransport) => void;
  url: string | (() => string | Promise<string>);
};
declare function createRealtimeTranscriptionWebSocketSession<Event = unknown>(options: RealtimeTranscriptionWebSocketSessionOptions<Event>): RealtimeTranscriptionSession;
//#endregion
export { getRealtimeTranscriptionProvider as a, canonicalizeRealtimeTranscriptionProviderId as i, RealtimeTranscriptionWebSocketTransport as n, listRealtimeTranscriptionProviders as o, createRealtimeTranscriptionWebSocketSession as r, normalizeRealtimeTranscriptionProviderId as s, RealtimeTranscriptionWebSocketSessionOptions as t };