// Anvil Voice provider module bridges OpenClaw Talk gateway relay to Anvil /v1/realtime.
import { randomUUID } from "node:crypto";
import type {
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  convertPcmToMulaw8k,
  mulawToPcm,
  resamplePcm,
} from "openclaw/plugin-sdk/realtime-voice";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { isPrivateOrLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import { asFiniteNumber, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import WebSocket from "ws";
import type { RawData } from "ws";

const ANVIL_REALTIME_PROVIDER_ID = "anvil";
const ANVIL_REALTIME_LABEL = "Anvil Voice";
const ANVIL_REALTIME_DEFAULT_MODEL = "fast-local";
const ANVIL_REALTIME_SAMPLE_RATE_HZ = 16_000;
const ANVIL_REALTIME_DEFAULT_SILENCE_DURATION_MS = 200;
const ANVIL_REALTIME_WS_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const ANVIL_REALTIME_MAX_PENDING_AUDIO_CHUNKS = 320;
const ANVIL_REALTIME_CONNECT_TIMEOUT_MS = 10_000;
const ANVIL_REALTIME_SILENCE_SAMPLE_ABS_THRESHOLD = 256;
const RECENT_FINAL_TRANSCRIPT_DEDUPE_MS = 2_000;
const LOOPBACK_HOSTNAME_ALIAS = ["local", "host"].join("");

type AnvilRealtimeVoiceProviderConfig = {
  realtimeUrl?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  voice?: string;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
};

type AnvilRealtimeVoiceBridgeConfig = RealtimeVoiceBridgeCreateRequest & {
  realtimeUrl: string;
  apiKey?: string;
  model?: string;
  voice?: string;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
};

type AnvilRealtimeEvent = {
  type?: string;
  delta?: string;
  text?: string;
  transcript?: string;
  item_id?: string;
  response_id?: string;
  event_id?: string;
  item?: {
    id?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  response?: {
    id?: string;
    status?: string;
  };
  error?: {
    type?: string;
    message?: string;
  };
};

function resolveAnvilProviderConfigRecord(
  config: RealtimeVoiceProviderConfig,
): Record<string, unknown> {
  const providers =
    typeof config.providers === "object" &&
    config.providers !== null &&
    !Array.isArray(config.providers)
      ? (config.providers as Record<string, unknown>)
      : undefined;
  const nested = providers?.anvil;
  if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  const direct = config.anvil;
  if (typeof direct === "object" && direct !== null && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  return config;
}

function asUnitInterval(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  return number !== undefined && number >= 0 && number <= 1 ? number : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  return number !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function normalizeProviderConfig(
  config: RealtimeVoiceProviderConfig,
): AnvilRealtimeVoiceProviderConfig {
  const raw = resolveAnvilProviderConfigRecord(config);
  const realtimeUrl = normalizeOptionalString(raw.realtimeUrl ?? raw.websocketUrl ?? raw.url);
  const baseUrl = normalizeOptionalString(raw.baseUrl);
  return {
    realtimeUrl: resolveAnvilRealtimeUrl({ realtimeUrl, baseUrl }),
    baseUrl,
    apiKey: normalizeResolvedSecretInputString({
      value: raw.apiKey ?? raw.token,
      path: "plugins.entries.voice-call.config.realtime.providers.anvil.apiKey",
    }),
    model: normalizeOptionalString(raw.model),
    voice: normalizeOptionalString(raw.speakerVoice ?? raw.voice),
    vadThreshold: asUnitInterval(raw.vadThreshold),
    silenceDurationMs: asNonNegativeInteger(raw.silenceDurationMs),
    prefixPaddingMs: asNonNegativeInteger(raw.prefixPaddingMs),
  };
}

export function resolveAnvilRealtimeUrl(params: {
  realtimeUrl?: string;
  baseUrl?: string;
}): string | undefined {
  if (params.realtimeUrl) {
    return normalizeRealtimeUrl(params.realtimeUrl, { appendRealtimePath: false });
  }
  if (params.baseUrl) {
    return normalizeRealtimeUrl(params.baseUrl, { appendRealtimePath: true });
  }
  return undefined;
}

function normalizeRealtimeUrl(rawUrl: string, options: { appendRealtimePath: boolean }): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new Error(
      `Anvil Voice realtime URL is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
  } else if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
  } else if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("Anvil Voice realtime URL must use ws://, wss://, http://, or https://");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "Anvil Voice realtime URL must not include credentials, query strings, or fragments",
    );
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/u, "");
  if (hostname === LOOPBACK_HOSTNAME_ALIAS) {
    throw new Error(
      "Anvil Voice realtime URL must use 127.0.0.1 instead of a loopback hostname alias",
    );
  }
  if (parsed.protocol === "ws:" && !isTrustedPlaintextHost(parsed.hostname)) {
    throw new Error(
      "Anvil Voice ws:// URLs must target loopback, private, .local, or .ts.net hosts; use wss:// for public hosts",
    );
  }

  if (options.appendRealtimePath) {
    const path = parsed.pathname.replace(/\/+$/u, "");
    if (!path) {
      parsed.pathname = "/v1/realtime";
    } else if (path.endsWith("/v1/realtime")) {
      parsed.pathname = path;
    } else if (path.endsWith("/v1")) {
      parsed.pathname = `${path}/realtime`;
    } else {
      parsed.pathname = `${path}/v1/realtime`;
    }
  }

  return parsed.toString();
}

function isTrustedPlaintextHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.+$/u, "");
  return (
    isPrivateOrLoopbackHost(hostname) ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".ts.net")
  );
}

function isPcm16Quiet(audio: Buffer): boolean {
  const samples = Math.floor(audio.length / 2);
  if (samples === 0) {
    return false;
  }
  for (let i = 0; i < samples; i += 1) {
    if (Math.abs(audio.readInt16LE(i * 2)) > ANVIL_REALTIME_SILENCE_SAMPLE_ABS_THRESHOLD) {
      return false;
    }
  }
  return true;
}

function pcm16DurationMs(audio: Buffer, sampleRateHz: number): number {
  return Math.round((Math.floor(audio.length / 2) / sampleRateHz) * 1000);
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function readErrorMessage(event: AnvilRealtimeEvent): string {
  return event.error?.message?.trim() || event.error?.type?.trim() || "Anvil Voice realtime error";
}

class AnvilRealtimeVoiceBridge implements RealtimeVoiceBridge {
  private readonly audioFormat: RealtimeVoiceAudioFormat;
  private socket: WebSocket | null = null;
  private connected = false;
  private ready = false;
  private intentionallyClosed = false;
  private pendingAudio: Buffer[] = [];
  private pendingUserMessages: string[] = [];
  private pendingGreeting: string | undefined;
  private speechSeenForBuffer = false;
  private consecutiveSilenceMs = 0;
  private activeResponseId: string | undefined;
  private canceledResponseIds = new Set<string>();
  private suppressUnidentifiedAudioAfterCancel = false;
  private resolveConnect: (() => void) | undefined;
  private rejectConnect: ((error: Error) => void) | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private emittedFinalUserTranscriptItemIds = new Set<string>();
  private recentFinalUserTranscript: { text: string; at: number } | undefined;

  constructor(private readonly config: AnvilRealtimeVoiceBridgeConfig) {
    this.audioFormat = config.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ;
  }

  connect(): Promise<void> {
    if (this.ready) {
      return Promise.resolve();
    }
    this.intentionallyClosed = false;
    return new Promise((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
      this.connectTimer = setTimeout(() => {
        const error = new Error("Anvil Voice realtime session.updated timed out");
        this.config.onError?.(error);
        this.settleConnectError(error);
        this.socket?.close(1011, "session.updated timeout");
      }, ANVIL_REALTIME_CONNECT_TIMEOUT_MS);
      this.connectTimer.unref?.();
      const headers: Record<string, string> = {};
      if (this.config.apiKey) {
        headers.Authorization = `Bearer ${this.config.apiKey}`;
      }
      const socket = new WebSocket(this.config.realtimeUrl, {
        headers,
        maxPayload: ANVIL_REALTIME_WS_MAX_PAYLOAD_BYTES,
      });
      this.socket = socket;
      socket.on("open", () => {
        this.connected = true;
        this.sendSessionUpdate();
      });
      socket.on("message", (data) => this.handleMessage(data));
      socket.on("error", (error) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.config.onError?.(normalized);
        this.settleConnectError(normalized);
      });
      socket.on("close", (code, reason) => {
        this.connected = false;
        this.ready = false;
        this.socket = null;
        const detail = `code=${code} reason=${reason.toString("utf8") || "none"}`;
        if (!this.intentionallyClosed) {
          const error = new Error(`Anvil Voice realtime WebSocket closed: ${detail}`);
          this.settleConnectError(error);
          this.config.onError?.(error);
          this.config.onClose?.("error");
          return;
        }
        this.config.onClose?.("completed");
      });
    });
  }

  sendAudio(audio: Buffer): void {
    if (!this.ready) {
      if (this.pendingAudio.length >= ANVIL_REALTIME_MAX_PENDING_AUDIO_CHUNKS) {
        this.pendingAudio.shift();
      }
      this.pendingAudio.push(audio);
      return;
    }
    this.sendAudioNow(audio);
  }

  setMediaTimestamp(_ts: number): void {}

  sendUserMessage(text: string): void {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }
    if (!this.ready) {
      this.pendingUserMessages.push(normalized);
      return;
    }
    this.sendJson({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: normalized }],
      },
    });
    this.sendJson({
      type: "response.create",
      event_id: `openclaw-anvil-response-create-${randomUUID()}`,
    });
  }

  triggerGreeting(instructions?: string): void {
    const greeting =
      instructions?.trim() || "Start the voice session now. Greet the person briefly.";
    if (!this.ready) {
      this.pendingGreeting = greeting;
      return;
    }
    this.sendUserMessage(greeting);
  }

  handleBargeIn(): void {
    if (!this.ready) {
      return;
    }
    if (this.activeResponseId) {
      this.canceledResponseIds.add(this.activeResponseId);
    } else {
      this.suppressUnidentifiedAudioAfterCancel = true;
    }
    this.sendJson({
      type: "response.cancel",
      event_id: `openclaw-anvil-response-cancel-${randomUUID()}`,
    });
    this.sendJson({ type: "input_audio_buffer.clear" });
    this.config.onClearAudio();
    this.config.onEvent?.({
      direction: "client",
      type: "response.cancel",
      detail: "reason=barge-in",
      responseId: this.activeResponseId,
    });
    this.resetInputBufferState();
  }

  submitToolResult(
    callId: string,
    _result: unknown,
    _options?: RealtimeVoiceToolResultOptions,
  ): void {
    this.config.onError?.(
      new Error(`Anvil Voice does not support realtime tool result submission for ${callId}`),
    );
  }

  acknowledgeMark(): void {}

  close(): void {
    this.intentionallyClosed = true;
    this.connected = false;
    this.ready = false;
    this.pendingAudio = [];
    this.pendingUserMessages = [];
    this.pendingGreeting = undefined;
    this.activeResponseId = undefined;
    this.canceledResponseIds.clear();
    this.suppressUnidentifiedAudioAfterCancel = false;
    this.emittedFinalUserTranscriptItemIds.clear();
    this.recentFinalUserTranscript = undefined;
    this.resetInputBufferState();
    this.clearConnectTimer();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  isConnected(): boolean {
    return this.connected && this.ready && this.socket?.readyState === WebSocket.OPEN;
  }

  private settleConnectReady(): void {
    const resolve = this.resolveConnect;
    this.clearConnectTimer();
    this.resolveConnect = undefined;
    this.rejectConnect = undefined;
    resolve?.();
  }

  private settleConnectError(error: Error): void {
    const reject = this.rejectConnect;
    this.clearConnectTimer();
    this.resolveConnect = undefined;
    this.rejectConnect = undefined;
    reject?.(error);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
  }

  private sendSessionUpdate(): void {
    const turnDetection: Record<string, unknown> = {
      type: "server_vad",
      threshold: this.config.vadThreshold ?? 0.5,
      prefix_padding_ms: this.config.prefixPaddingMs ?? 0,
      silence_duration_ms:
        this.config.silenceDurationMs ?? ANVIL_REALTIME_DEFAULT_SILENCE_DURATION_MS,
      create_response: this.config.autoRespondToAudio !== false,
      interrupt_response: this.config.interruptResponseOnInputAudio !== false,
    };
    this.sendJson({
      type: "session.update",
      session: {
        type: "realtime",
        model: this.config.model ?? ANVIL_REALTIME_DEFAULT_MODEL,
        ...(this.config.instructions ? { instructions: this.config.instructions } : {}),
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: ANVIL_REALTIME_SAMPLE_RATE_HZ },
            turn_detection: turnDetection,
          },
          output: {
            format: { type: "audio/pcm", rate: ANVIL_REALTIME_SAMPLE_RATE_HZ },
            ...(this.config.voice ? { voice: this.config.voice } : {}),
          },
        },
      },
    });
  }

  private flushPending(): void {
    for (const audio of this.pendingAudio.splice(0)) {
      this.sendAudioNow(audio);
    }
    for (const text of this.pendingUserMessages.splice(0)) {
      this.sendUserMessage(text);
    }
    if (this.pendingGreeting !== undefined) {
      const greeting = this.pendingGreeting;
      this.pendingGreeting = undefined;
      this.sendUserMessage(greeting);
    }
  }

  private sendAudioNow(audio: Buffer): void {
    const pcm16k = this.toAnvilInputPcm(audio);
    if (pcm16k.length === 0) {
      return;
    }
    const silence = isPcm16Quiet(pcm16k);
    if (!this.speechSeenForBuffer && silence) {
      return;
    }
    this.sendJson({
      type: "input_audio_buffer.append",
      audio: pcm16k.toString("base64"),
    });
    if (!silence) {
      this.speechSeenForBuffer = true;
      this.consecutiveSilenceMs = 0;
      return;
    }
    this.consecutiveSilenceMs += pcm16DurationMs(pcm16k, ANVIL_REALTIME_SAMPLE_RATE_HZ);
    const threshold = this.config.silenceDurationMs ?? ANVIL_REALTIME_DEFAULT_SILENCE_DURATION_MS;
    if (this.consecutiveSilenceMs >= threshold) {
      this.sendJson({ type: "input_audio_buffer.commit" });
      this.resetInputBufferState();
    }
  }

  private resetInputBufferState(): void {
    this.speechSeenForBuffer = false;
    this.consecutiveSilenceMs = 0;
  }

  private toAnvilInputPcm(audio: Buffer): Buffer {
    const pcm = this.audioFormat.encoding === "pcm16" ? audio : mulawToPcm(audio);
    const inputSampleRateHz: number = this.audioFormat.sampleRateHz;
    return inputSampleRateHz === ANVIL_REALTIME_SAMPLE_RATE_HZ
      ? pcm
      : resamplePcm(pcm, inputSampleRateHz, ANVIL_REALTIME_SAMPLE_RATE_HZ);
  }

  private fromAnvilOutputPcm(audio: Buffer): Buffer {
    if (this.audioFormat.encoding === "g711_ulaw") {
      return convertPcmToMulaw8k(audio, ANVIL_REALTIME_SAMPLE_RATE_HZ);
    }
    const outputSampleRateHz: number = this.audioFormat.sampleRateHz;
    return outputSampleRateHz === ANVIL_REALTIME_SAMPLE_RATE_HZ
      ? audio
      : resamplePcm(audio, ANVIL_REALTIME_SAMPLE_RATE_HZ, outputSampleRateHz);
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(payload));
  }

  private handleMessage(data: RawData): void {
    let event: AnvilRealtimeEvent;
    try {
      event = JSON.parse(rawDataToString(data)) as AnvilRealtimeEvent;
    } catch (error) {
      this.config.onError?.(
        new Error(
          `Anvil Voice realtime sent invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }
    const type = event.type;
    if (!type) {
      this.config.onError?.(new Error("Anvil Voice realtime event missing type"));
      return;
    }
    this.config.onEvent?.({
      direction: "server",
      type,
      itemId: event.item_id ?? event.item?.id,
      responseId: event.response_id ?? event.response?.id,
    });

    switch (type) {
      case "session.updated":
        this.ready = true;
        this.settleConnectReady();
        this.config.onReady?.();
        this.flushPending();
        break;
      case "response.created":
        this.activeResponseId = event.response?.id ?? event.response_id ?? this.activeResponseId;
        this.suppressUnidentifiedAudioAfterCancel = false;
        break;
      case "response.output_audio.delta":
      case "response.audio.delta":
      case "conversation.output_audio.delta":
        this.handleAudioDelta(event);
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (
          event.transcript &&
          this.shouldEmitFinalUserTranscript(event.transcript, event.item_id ?? event.item?.id)
        ) {
          this.config.onTranscript?.("user", event.transcript, true);
        }
        break;
      case "conversation.item.created":
        this.handleConversationItemCreated(event);
        break;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        if (event.delta) {
          this.config.onTranscript?.("assistant", event.delta, false);
        }
        break;
      case "response.done":
      case "response.cancelled":
        this.clearResponseCancellation(event);
        this.activeResponseId = undefined;
        break;
      case "error":
        this.config.onError?.(new Error(readErrorMessage(event)));
        break;
      default:
        break;
    }
  }

  private handleAudioDelta(event: AnvilRealtimeEvent): void {
    if (this.shouldSuppressAudioDelta(event)) {
      return;
    }
    const delta = event.delta;
    if (!delta) {
      return;
    }
    try {
      const audio = this.fromAnvilOutputPcm(Buffer.from(delta, "base64"));
      if (audio.length > 0) {
        this.config.onAudio(audio);
      }
    } catch (error) {
      this.config.onError?.(
        new Error(
          `Anvil Voice realtime audio delta decode failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  private shouldSuppressAudioDelta(event: AnvilRealtimeEvent): boolean {
    const responseId = event.response_id ?? event.response?.id;
    if (responseId) {
      return this.canceledResponseIds.has(responseId);
    }
    return this.suppressUnidentifiedAudioAfterCancel;
  }

  private clearResponseCancellation(event: AnvilRealtimeEvent): void {
    const responseId = event.response_id ?? event.response?.id ?? this.activeResponseId;
    if (responseId) {
      this.canceledResponseIds.delete(responseId);
    }
    this.suppressUnidentifiedAudioAfterCancel = false;
  }

  private handleConversationItemCreated(event: AnvilRealtimeEvent): void {
    if (event.item?.role !== "user") {
      return;
    }
    const text = event.item.content
      ?.map((part) => (part.type === "input_text" || part.type === "text" ? part.text : undefined))
      .filter((part): part is string => Boolean(part?.trim()))
      .join("\n");
    if (text) {
      if (!this.shouldEmitFinalUserTranscript(text, event.item.id)) {
        return;
      }
      this.config.onTranscript?.("user", text, true);
    }
  }

  private shouldEmitFinalUserTranscript(text: string, itemId?: string): boolean {
    const normalized = text.replace(/\s+/gu, " ").trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    if (itemId) {
      if (this.emittedFinalUserTranscriptItemIds.has(itemId)) {
        return false;
      }
      this.emittedFinalUserTranscriptItemIds.add(itemId);
      if (this.emittedFinalUserTranscriptItemIds.size > 128) {
        const oldest = this.emittedFinalUserTranscriptItemIds.values().next().value as
          | string
          | undefined;
        if (oldest) {
          this.emittedFinalUserTranscriptItemIds.delete(oldest);
        }
      }
    }
    const now = Date.now();
    if (
      this.recentFinalUserTranscript &&
      this.recentFinalUserTranscript.text === normalized &&
      now - this.recentFinalUserTranscript.at < RECENT_FINAL_TRANSCRIPT_DEDUPE_MS
    ) {
      return false;
    }
    this.recentFinalUserTranscript = { text: normalized, at: now };
    return true;
  }
}

export function buildAnvilRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    id: ANVIL_REALTIME_PROVIDER_ID,
    label: ANVIL_REALTIME_LABEL,
    defaultModel: ANVIL_REALTIME_DEFAULT_MODEL,
    capabilities: {
      transports: ["gateway-relay"],
      inputAudioFormats: [
        REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      outputAudioFormats: [
        REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      supportsBrowserSession: false,
      supportsBargeIn: true,
      supportsToolCalls: false,
    },
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ providerConfig }) =>
      Boolean(normalizeProviderConfig(providerConfig).realtimeUrl),
    createBridge: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      if (!config.realtimeUrl) {
        throw new Error("Anvil Voice realtime URL missing");
      }
      return new AnvilRealtimeVoiceBridge({
        ...req,
        realtimeUrl: config.realtimeUrl,
        apiKey: config.apiKey,
        model: config.model,
        voice: config.voice,
        vadThreshold: config.vadThreshold,
        silenceDurationMs: config.silenceDurationMs,
        prefixPaddingMs: config.prefixPaddingMs,
      });
    },
  };
}
