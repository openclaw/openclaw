import { randomUUID } from "node:crypto";
import {
  captureWsEvent,
  createDebugProxyWebSocketAgent,
  resolveDebugProxySettings,
} from "openclaw/plugin-sdk/proxy-capture";
import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import WebSocket from "ws";
import { XAI_BASE_URL } from "./model-definitions.js";

type XaiRealtimeTranscriptionEncoding = "pcm" | "mulaw" | "alaw";

type XaiRealtimeTranscriptionProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  sampleRate?: number;
  encoding?: XaiRealtimeTranscriptionEncoding;
  interimResults?: boolean;
  endpointingMs?: number;
  language?: string;
};

type XaiRealtimeTranscriptionSessionConfig = RealtimeTranscriptionSessionCreateRequest & {
  apiKey: string;
  baseUrl: string;
  sampleRate: number;
  encoding: XaiRealtimeTranscriptionEncoding;
  interimResults: boolean;
  endpointingMs: number;
  language?: string;
};

type XaiRealtimeTranscriptionEvent = {
  type?: string;
  text?: string;
  transcript?: string;
  is_final?: boolean;
  speech_final?: boolean;
  error?: unknown;
  message?: string;
};

const XAI_REALTIME_STT_DEFAULT_SAMPLE_RATE = 8000;
const XAI_REALTIME_STT_DEFAULT_ENCODING: XaiRealtimeTranscriptionEncoding = "mulaw";
const XAI_REALTIME_STT_DEFAULT_ENDPOINTING_MS = 800;
const XAI_REALTIME_STT_CONNECT_TIMEOUT_MS = 10_000;
const XAI_REALTIME_STT_CLOSE_TIMEOUT_MS = 5_000;
const XAI_REALTIME_STT_MAX_RECONNECT_ATTEMPTS = 5;
const XAI_REALTIME_STT_RECONNECT_DELAY_MS = 1000;
const XAI_REALTIME_STT_MAX_QUEUED_BYTES = 2 * 1024 * 1024;

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readNestedXaiConfig(rawConfig: RealtimeTranscriptionProviderConfig) {
  const raw = readRecord(rawConfig);
  const providers = readRecord(raw?.providers);
  return readRecord(providers?.xai ?? raw?.xai ?? raw) ?? {};
}

function readFiniteNumber(value: unknown): number | undefined {
  const next =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : undefined;
  return Number.isFinite(next) ? next : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function normalizeEncoding(value: unknown): XaiRealtimeTranscriptionEncoding | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "ulaw" || normalized === "g711_ulaw" || normalized === "g711-mulaw") {
    return "mulaw";
  }
  if (normalized === "g711_alaw" || normalized === "g711-alaw") {
    return "alaw";
  }
  if (normalized === "pcm" || normalized === "mulaw" || normalized === "alaw") {
    return normalized;
  }
  throw new Error(`Invalid xAI realtime transcription encoding: ${normalized}`);
}

function normalizeXaiRealtimeBaseUrl(value?: string): string {
  return normalizeOptionalString(value ?? process.env.XAI_BASE_URL) ?? XAI_BASE_URL;
}

function toXaiRealtimeWsUrl(config: XaiRealtimeTranscriptionSessionConfig): string {
  const url = new URL(normalizeXaiRealtimeBaseUrl(config.baseUrl));
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/stt`;
  url.searchParams.set("sample_rate", String(config.sampleRate));
  url.searchParams.set("encoding", config.encoding);
  url.searchParams.set("interim_results", String(config.interimResults));
  url.searchParams.set("endpointing", String(config.endpointingMs));
  if (config.language) {
    url.searchParams.set("language", config.language);
  }
  return url.toString();
}

function normalizeProviderConfig(
  config: RealtimeTranscriptionProviderConfig,
): XaiRealtimeTranscriptionProviderConfig {
  const raw = readNestedXaiConfig(config);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw.apiKey,
      path: "plugins.entries.voice-call.config.streaming.providers.xai.apiKey",
    }),
    baseUrl: normalizeOptionalString(raw.baseUrl),
    sampleRate: readFiniteNumber(raw.sampleRate ?? raw.sample_rate),
    encoding: normalizeEncoding(raw.encoding),
    interimResults: readBoolean(raw.interimResults ?? raw.interim_results),
    endpointingMs: readFiniteNumber(raw.endpointingMs ?? raw.endpointing ?? raw.silenceDurationMs),
    language: normalizeOptionalString(raw.language),
  };
}

function readErrorDetail(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const record = readRecord(value);
  const message = normalizeOptionalString(record?.message);
  const code = normalizeOptionalString(record?.code);
  return message ?? code ?? "xAI realtime transcription error";
}

function readTranscriptText(event: XaiRealtimeTranscriptionEvent): string | undefined {
  return normalizeOptionalString(event.text ?? event.transcript);
}

class XaiRealtimeTranscriptionSession implements RealtimeTranscriptionSession {
  private ws: WebSocket | null = null;
  private connected = false;
  private ready = false;
  private closed = false;
  private reconnectAttempts = 0;
  private queuedAudio: Buffer[] = [];
  private queuedBytes = 0;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private lastTranscript: string | undefined;
  private speechStarted = false;
  private reconnecting = false;
  private readonly flowId = randomUUID();

  constructor(private readonly config: XaiRealtimeTranscriptionSessionConfig) {}

  async connect(): Promise<void> {
    this.closed = false;
    this.reconnectAttempts = 0;
    await this.doConnect();
  }

  sendAudio(audio: Buffer): void {
    if (this.closed) {
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN && this.ready) {
      this.sendAudioFrame(audio);
      return;
    }
    this.queueAudio(audio);
  }

  close(): void {
    this.closed = true;
    this.connected = false;
    this.queuedAudio = [];
    this.queuedBytes = 0;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.forceClose();
      return;
    }
    this.sendEvent({ type: "audio.done" });
    this.closeTimer = setTimeout(() => this.forceClose(), XAI_REALTIME_STT_CLOSE_TIMEOUT_MS);
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async doConnect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const url = toXaiRealtimeWsUrl(this.config);
      const debugProxy = resolveDebugProxySettings();
      const proxyAgent = createDebugProxyWebSocketAgent(debugProxy);
      let settled = false;
      let opened = false;
      const finishConnect = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimeout);
        this.ready = true;
        this.flushQueuedAudio();
        resolve();
      };
      const failConnect = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimeout);
        this.config.onError?.(error);
        this.closed = true;
        this.forceClose();
        reject(error);
      };
      this.ready = false;
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        ...(proxyAgent ? { agent: proxyAgent } : {}),
      });

      const connectTimeout = setTimeout(() => {
        failConnect(new Error("xAI realtime transcription connection timeout"));
      }, XAI_REALTIME_STT_CONNECT_TIMEOUT_MS);

      this.ws.on("open", () => {
        opened = true;
        this.connected = true;
        this.reconnectAttempts = 0;
        captureWsEvent({
          url,
          direction: "local",
          kind: "ws-open",
          flowId: this.flowId,
          meta: { provider: "xai", capability: "realtime-transcription" },
        });
      });

      this.ws.on("message", (data: Buffer) => {
        captureWsEvent({
          url,
          direction: "inbound",
          kind: "ws-frame",
          flowId: this.flowId,
          payload: data,
          meta: { provider: "xai", capability: "realtime-transcription" },
        });
        try {
          const event = JSON.parse(data.toString()) as XaiRealtimeTranscriptionEvent;
          if (event.type === "transcript.created") {
            finishConnect();
            return;
          }
          if (!this.ready && event.type === "error") {
            failConnect(new Error(readErrorDetail(event.error ?? event.message)));
            return;
          }
          this.handleEvent(event);
        } catch (error) {
          this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      });

      this.ws.on("error", (error) => {
        captureWsEvent({
          url,
          direction: "local",
          kind: "error",
          flowId: this.flowId,
          errorText: error instanceof Error ? error.message : String(error),
          meta: { provider: "xai", capability: "realtime-transcription" },
        });
        if (!this.ready) {
          failConnect(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      });

      this.ws.on("close", () => {
        clearTimeout(connectTimeout);
        this.connected = false;
        this.ready = false;
        if (this.closeTimer) {
          clearTimeout(this.closeTimer);
          this.closeTimer = undefined;
        }
        if (this.closed) {
          return;
        }
        if (!opened || !settled) {
          return;
        }
        void this.attemptReconnect();
      });
    });
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.reconnecting) {
      return;
    }
    if (this.reconnectAttempts >= XAI_REALTIME_STT_MAX_RECONNECT_ATTEMPTS) {
      this.config.onError?.(new Error("xAI realtime transcription reconnect limit reached"));
      return;
    }
    this.reconnectAttempts += 1;
    const delay = XAI_REALTIME_STT_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1);
    this.reconnecting = true;
    try {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (this.closed) {
        return;
      }
      await this.doConnect();
    } catch {
      if (!this.closed) {
        this.reconnecting = false;
        await this.attemptReconnect();
        return;
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private handleEvent(event: XaiRealtimeTranscriptionEvent): void {
    switch (event.type) {
      case "transcript.partial": {
        const text = readTranscriptText(event);
        if (!text) {
          return;
        }
        if (!this.speechStarted) {
          this.speechStarted = true;
          this.config.onSpeechStart?.();
        }
        if (event.is_final && event.speech_final) {
          this.emitTranscript(text);
          this.speechStarted = false;
          return;
        }
        this.config.onPartial?.(text);
        return;
      }
      case "transcript.done": {
        const text = readTranscriptText(event);
        if (text) {
          this.emitTranscript(text);
        }
        this.forceClose();
        return;
      }
      case "error":
        this.config.onError?.(new Error(readErrorDetail(event.error ?? event.message)));
        return;
      default:
        return;
    }
  }

  private emitTranscript(text: string): void {
    if (text === this.lastTranscript) {
      return;
    }
    this.lastTranscript = text;
    this.config.onTranscript?.(text);
  }

  private queueAudio(audio: Buffer): void {
    if (audio.byteLength === 0) {
      return;
    }
    this.queuedAudio.push(Buffer.from(audio));
    this.queuedBytes += audio.byteLength;
    while (this.queuedBytes > XAI_REALTIME_STT_MAX_QUEUED_BYTES && this.queuedAudio.length > 0) {
      const dropped = this.queuedAudio.shift();
      this.queuedBytes -= dropped?.byteLength ?? 0;
    }
  }

  private flushQueuedAudio(): void {
    for (const audio of this.queuedAudio) {
      this.sendAudioFrame(audio);
    }
    this.queuedAudio = [];
    this.queuedBytes = 0;
  }

  private sendAudioFrame(audio: Buffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.queueAudio(audio);
      return;
    }
    captureWsEvent({
      url: toXaiRealtimeWsUrl(this.config),
      direction: "outbound",
      kind: "ws-frame",
      flowId: this.flowId,
      payload: audio,
      meta: { provider: "xai", capability: "realtime-transcription" },
    });
    this.ws.send(audio);
  }

  private sendEvent(event: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    const payload = JSON.stringify(event);
    captureWsEvent({
      url: toXaiRealtimeWsUrl(this.config),
      direction: "outbound",
      kind: "ws-frame",
      flowId: this.flowId,
      payload,
      meta: { provider: "xai", capability: "realtime-transcription" },
    });
    this.ws.send(payload);
  }

  private forceClose(): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }
    this.connected = false;
    this.ready = false;
    if (this.ws) {
      this.ws.close(1000, "Transcription session closed");
      this.ws = null;
    }
  }
}

export function buildXaiRealtimeTranscriptionProvider(): RealtimeTranscriptionProviderPlugin {
  return {
    id: "xai",
    label: "xAI Realtime Transcription",
    aliases: ["xai-realtime", "grok-stt-streaming"],
    autoSelectOrder: 25,
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ providerConfig }) =>
      Boolean(normalizeProviderConfig(providerConfig).apiKey || process.env.XAI_API_KEY),
    createSession: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      const apiKey = config.apiKey || process.env.XAI_API_KEY;
      if (!apiKey) {
        throw new Error("xAI API key missing");
      }
      return new XaiRealtimeTranscriptionSession({
        ...req,
        apiKey,
        baseUrl: normalizeXaiRealtimeBaseUrl(config.baseUrl),
        sampleRate: config.sampleRate ?? XAI_REALTIME_STT_DEFAULT_SAMPLE_RATE,
        encoding: config.encoding ?? XAI_REALTIME_STT_DEFAULT_ENCODING,
        interimResults: config.interimResults ?? true,
        endpointingMs: config.endpointingMs ?? XAI_REALTIME_STT_DEFAULT_ENDPOINTING_MS,
        language: config.language,
      });
    },
  };
}
