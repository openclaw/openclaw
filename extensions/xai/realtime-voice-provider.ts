// Xai provider module implements realtime voice provider integration.
import { resolveExpiresAtMsFromEpochSeconds } from "openclaw/plugin-sdk/number-runtime";
import {
  isProviderAuthProfileConfigured,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  createProviderHttpError,
  resolveProviderRequestHeaders,
} from "openclaw/plugin-sdk/provider-http";
import type {
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBargeInOptions,
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceTool,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
} from "openclaw/plugin-sdk/realtime-voice";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeOptionalString,
  parseFiniteNumber as readFiniteNumber,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import WebSocket from "ws";
import type { RawData } from "ws";
import { XAI_BASE_URL } from "./model-definitions.js";
import { xaiUserAgentHeaderFor } from "./src/xai-user-agent.js";

type XaiRealtimeVoiceProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  interruptResponseOnInputAudio?: boolean;
  minBargeInAudioEndMs?: number;
};

type XaiRealtimeVoiceBridgeConfig = RealtimeVoiceBridgeCreateRequest & {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  interruptResponseOnInputAudio?: boolean;
  minBargeInAudioEndMs?: number;
};

type XaiRealtimeSpeakTextOptions = {
  mode?: "exact" | "natural";
};

type XaiRealtimeAudioFormatConfig =
  | {
      type: "audio/pcm";
      rate: 24000;
    }
  | {
      type: "audio/pcmu";
    };

type XaiRealtimeTurnDetectionConfig = {
  type: "server_vad";
  threshold: number;
  prefix_padding_ms: number;
  silence_duration_ms: number;
  create_response: boolean;
  interrupt_response?: boolean;
};

type XaiRealtimeSessionUpdate = {
  type: "session.update";
  session: {
    instructions?: string;
    voice: string;
    turn_detection: XaiRealtimeTurnDetectionConfig;
    audio: {
      input: {
        format: XaiRealtimeAudioFormatConfig;
        transcription: { model: "grok-transcribe" };
      };
      output: {
        format: XaiRealtimeAudioFormatConfig;
      };
    };
    tools?: RealtimeVoiceTool[];
    tool_choice?: string;
  };
};

type XaiRealtimeEvent = {
  type: string;
  delta?: string;
  data?: string;
  text?: string;
  transcript?: string;
  item_id?: string;
  response_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  item?: {
    id?: string;
    type?: string;
    name?: string;
    call_id?: string;
    arguments?: string;
  };
  response?: {
    id?: string;
    status?: string;
    status_details?: unknown;
  };
  error?: unknown;
};

const XAI_REALTIME_DEFAULT_MODEL = "grok-voice-latest";
const XAI_REALTIME_DEFAULT_VOICE = "leo";
const XAI_REALTIME_TRANSCRIPTION_MODEL = "grok-transcribe";
const XAI_REALTIME_BROWSER_CLIENT_SECRET_TTL_SECONDS = 300;
const XAI_REALTIME_CONNECT_TIMEOUT_MS = 10_000;
const XAI_REALTIME_MAX_RECONNECT_ATTEMPTS = 3;
const XAI_REALTIME_BASE_RECONNECT_DELAY_MS = 500;
const XAI_REALTIME_DEFAULT_MIN_BARGE_IN_AUDIO_END_MS = 250;
const XAI_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX =
  "Conversation already has an active response in progress:";
const XAI_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR =
  "Cancellation failed: no active response found";

const XAI_REALTIME_MODELS = [
  "grok-voice-latest",
  "grok-voice-think-fast-1.0",
  "grok-voice-fast-1.0",
] as const;

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readNestedXaiConfig(rawConfig: RealtimeVoiceProviderConfig): Record<string, unknown> {
  const raw = readRecord(rawConfig);
  const providers = readRecord(raw?.providers);
  return readRecord(providers?.xai ?? raw?.xai ?? raw) ?? {};
}

function asUnitInterval(value: unknown): number | undefined {
  const number = readFiniteNumber(value);
  return number !== undefined && number >= 0 && number <= 1 ? number : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  const number = readFiniteNumber(value);
  return number !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeXaiRealtimeBaseUrl(value?: string): string {
  return normalizeOptionalString(value ?? process.env.XAI_BASE_URL) ?? XAI_BASE_URL;
}

function normalizeProviderConfig(
  config: RealtimeVoiceProviderConfig,
): XaiRealtimeVoiceProviderConfig {
  const raw = readNestedXaiConfig(config);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw.apiKey,
      path: "talk.realtime.providers.xai.apiKey",
    }),
    baseUrl: normalizeOptionalString(raw.baseUrl),
    model: normalizeOptionalString(raw.model),
    voice: normalizeOptionalString(
      raw.speakerVoice ?? raw.speakerVoiceId ?? raw.voice ?? raw.voiceId,
    ),
    vadThreshold: asUnitInterval(raw.vadThreshold),
    silenceDurationMs: asNonNegativeInteger(raw.silenceDurationMs),
    prefixPaddingMs: asNonNegativeInteger(raw.prefixPaddingMs),
    interruptResponseOnInputAudio: readBoolean(raw.interruptResponseOnInputAudio),
    minBargeInAudioEndMs: asNonNegativeInteger(raw.minBargeInAudioEndMs),
  };
}

function toXaiRealtimeWsUrl(config: { baseUrl?: string; model: string }): string {
  const url = new URL(normalizeXaiRealtimeBaseUrl(config.baseUrl));
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/realtime`;
  url.searchParams.set("model", config.model);
  return url.toString();
}

function toXaiRealtimeClientSecretsUrl(baseUrl?: string): string {
  const url = new URL(normalizeXaiRealtimeBaseUrl(baseUrl));
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/realtime/client_secrets`;
  url.search = "";
  return url.toString();
}

function toXaiAudioFormat(format: RealtimeVoiceAudioFormat): XaiRealtimeAudioFormatConfig {
  if (format.encoding === "pcm16") {
    return { type: "audio/pcm", rate: 24000 };
  }
  return { type: "audio/pcmu" };
}

function base64ToBuffer(value: string): Buffer {
  return Buffer.from(value, "base64");
}

function rawRealtimeMessageToString(data: RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function readRealtimeErrorDetail(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const record = readRecord(value);
  const nested = readRecord(record?.error);
  return (
    normalizeOptionalString(record?.message) ??
    normalizeOptionalString(nested?.message) ??
    normalizeOptionalString(record?.code) ??
    "xAI realtime voice error"
  );
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return normalizeOptionalString((value as Record<string, unknown>)[key]);
}

function buildXaiRealtimeSessionUpdate(params: {
  instructions?: string;
  voice?: string;
  audioFormat: RealtimeVoiceAudioFormat;
  tools?: RealtimeVoiceTool[];
  autoRespondToAudio?: boolean;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  interruptResponseOnInputAudio?: boolean;
}): XaiRealtimeSessionUpdate {
  const autoRespondToAudio = params.autoRespondToAudio ?? true;
  const interruptResponseOnInputAudio = params.interruptResponseOnInputAudio ?? autoRespondToAudio;
  return {
    type: "session.update",
    session: {
      instructions: params.instructions,
      voice: params.voice ?? XAI_REALTIME_DEFAULT_VOICE,
      turn_detection: {
        type: "server_vad",
        threshold: params.vadThreshold ?? 0.85,
        prefix_padding_ms: params.prefixPaddingMs ?? 333,
        silence_duration_ms: params.silenceDurationMs ?? 500,
        create_response: autoRespondToAudio,
        interrupt_response: interruptResponseOnInputAudio,
      },
      audio: {
        input: {
          format: toXaiAudioFormat(params.audioFormat),
          transcription: { model: XAI_REALTIME_TRANSCRIPTION_MODEL },
        },
        output: {
          format: toXaiAudioFormat(params.audioFormat),
        },
      },
      ...(params.tools && params.tools.length > 0
        ? {
            tools: params.tools,
            tool_choice: "auto",
          }
        : {}),
    },
  };
}

async function createXaiRealtimeClientSecret(params: {
  apiKey: string;
  baseUrl?: string;
}): Promise<{ value: string; expiresAt?: number }> {
  const url = toXaiRealtimeClientSecretsUrl(params.baseUrl);
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "POST",
      headers: resolveProviderRequestHeaders({
        provider: "xai",
        baseUrl: url,
        capability: "audio",
        transport: "http",
        defaultHeaders: {
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
        },
      }) ?? {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expires_after: {
          seconds: XAI_REALTIME_BROWSER_CLIENT_SECRET_TTL_SECONDS,
        },
      }),
    },
    auditContext: "xai-realtime-browser-session",
  });
  const payload = await (async () => {
    try {
      if (!response.ok) {
        throw await createProviderHttpError(response, "xAI Realtime client secret failed");
      }
      return (await response.json()) as unknown;
    } finally {
      await release();
    }
  })();
  const value = readStringField(payload, "value");
  if (!value) {
    throw new Error("xAI Realtime client secret response did not include a value");
  }
  const expiresAt =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).expires_at
      : undefined;
  const expiresAtMs = resolveExpiresAtMsFromEpochSeconds(expiresAt);
  return {
    value,
    ...(expiresAtMs === undefined ? {} : { expiresAt: expiresAtMs }),
  };
}

async function resolveXaiRealtimeApiKey(params: {
  configApiKey?: string;
  cfg?: OpenClawConfig;
}): Promise<string> {
  const direct =
    normalizeOptionalString(params.configApiKey) ??
    normalizeOptionalString(process.env.XAI_API_KEY);
  if (direct) {
    return direct;
  }
  const auth = await resolveApiKeyForProvider({ provider: "xai", cfg: params.cfg });
  const profileKey = normalizeOptionalString(auth?.apiKey);
  if (profileKey) {
    return profileKey;
  }
  throw new Error(
    "xAI credentials missing for realtime voice. Sign in with `openclaw onboard --auth-choice xai-oauth`, run `openclaw onboard --auth-choice xai-api-key`, set XAI_API_KEY, or configure talk.realtime.providers.xai.apiKey.",
  );
}

class XaiRealtimeVoiceBridge implements RealtimeVoiceBridge {
  readonly supportsToolResultContinuation = true;

  private ws: WebSocket | null = null;
  private connected = false;
  private intentionallyClosed = false;
  private sessionConfigured = false;
  private pendingAudio: Buffer[] = [];
  private markQueue: string[] = [];
  private responseStartTimestamp: number | null = null;
  private responseActive = false;
  private responseCreateInFlight = false;
  private responseCancelInFlight = false;
  private responseCreatePending = false;
  private continuingToolCallIds = new Set<string>();
  private latestMediaTimestamp = 0;
  private lastAssistantItemId: string | null = null;
  private toolCallBuffers = new Map<string, { name: string; callId: string; args: string }>();
  private deliveredToolCallKeys = new Set<string>();
  private sessionReadyFired = false;
  private reconnectAttempts = 0;
  private readonly audioFormat: RealtimeVoiceAudioFormat;

  constructor(private readonly config: XaiRealtimeVoiceBridgeConfig) {
    this.audioFormat = config.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ;
  }

  async connect(): Promise<void> {
    this.intentionallyClosed = false;
    this.reconnectAttempts = 0;
    await this.doConnect();
  }

  sendAudio(audio: Buffer): void {
    if (!this.connected || !this.sessionConfigured || this.ws?.readyState !== WebSocket.OPEN) {
      if (this.pendingAudio.length < 320) {
        this.pendingAudio.push(audio);
      }
      return;
    }
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: audio.toString("base64"),
    });
  }

  setMediaTimestamp(ts: number): void {
    this.latestMediaTimestamp = ts;
  }

  sendUserMessage(text: string): void {
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.requestResponseCreate();
  }

  speakText(text: string, options?: XaiRealtimeSpeakTextOptions): void {
    const mode = options?.mode ?? "exact";
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "force_message",
        role: "assistant",
        interruptible: true,
        content: [
          {
            type: "output_text",
            text: mode === "natural" ? text : text.trim(),
          },
        ],
      },
    });
  }

  triggerGreeting(instructions?: string): void {
    if (!this.isConnected() || !this.ws) {
      return;
    }
    this.sendUserMessage(instructions ?? this.config.instructions ?? "Greet the user.");
  }

  submitToolResult(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void {
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
    if (options?.willContinue === true) {
      this.continuingToolCallIds.add(callId);
      return;
    }
    this.continuingToolCallIds.delete(callId);
    if (options?.suppressResponse === true) {
      return;
    }
    this.requestResponseCreate();
  }

  acknowledgeMark(): void {
    if (this.markQueue.length > 0) {
      this.markQueue.shift();
    }
  }

  handleBargeIn(options?: RealtimeVoiceBargeInOptions): void {
    const assistantItemId = this.lastAssistantItemId;
    const responseStartTimestamp = this.responseStartTimestamp;
    const force = options?.force === true;
    const shouldInterruptProvider =
      assistantItemId !== null &&
      ((responseStartTimestamp !== null &&
        (this.markQueue.length > 0 || options?.audioPlaybackActive === true)) ||
        force);
    const audioEndMs = shouldInterruptProvider
      ? Math.max(
          0,
          responseStartTimestamp === null
            ? this.latestMediaTimestamp
            : this.latestMediaTimestamp - responseStartTimestamp,
        )
      : null;
    const minBargeInAudioEndMs =
      this.config.minBargeInAudioEndMs ?? XAI_REALTIME_DEFAULT_MIN_BARGE_IN_AUDIO_END_MS;
    if (!force && audioEndMs !== null && audioEndMs < minBargeInAudioEndMs) {
      this.config.onEvent?.({
        direction: "client",
        type: "conversation.item.truncate.skipped",
        detail: `reason=barge-in audioEndMs=${audioEndMs} minAudioEndMs=${minBargeInAudioEndMs}`,
      });
      return;
    }
    if (
      options?.audioPlaybackActive === true &&
      this.responseActive &&
      !this.responseCancelInFlight
    ) {
      this.sendEvent({ type: "response.cancel" }, "reason=barge-in");
      this.responseCancelInFlight = true;
    }
    if (shouldInterruptProvider) {
      this.sendEvent(
        {
          type: "conversation.item.truncate",
          item_id: assistantItemId,
          content_index: 0,
          audio_end_ms: audioEndMs,
        },
        `reason=barge-in audioEndMs=${audioEndMs}`,
      );
      this.config.onClearAudio();
      this.markQueue = [];
      this.lastAssistantItemId = null;
      this.responseStartTimestamp = null;
      return;
    }
    this.config.onClearAudio();
  }

  close(): void {
    this.intentionallyClosed = true;
    this.connected = false;
    this.sessionConfigured = false;
    if (this.ws) {
      this.ws.close(1000, "Bridge closed");
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.connected && this.sessionConfigured;
  }

  private async doConnect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const connectTimeout: ReturnType<typeof setTimeout> = setTimeout(() => {
        if (!this.sessionConfigured && !this.intentionallyClosed) {
          this.ws?.terminate();
          settleReject(new Error("xAI realtime voice connection timeout"));
        }
      }, XAI_REALTIME_CONNECT_TIMEOUT_MS);
      const settleResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimeout);
        resolve();
      };
      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimeout);
        reject(error);
      };
      const openWebSocket = (connection: { url: string; headers: Record<string, string> }) => {
        if (settled) {
          return;
        }
        if (this.intentionallyClosed) {
          settleResolve();
          return;
        }
        const ws = new WebSocket(connection.url, { headers: connection.headers });
        this.ws = ws;

        const rejectStartup = (error: Error) => {
          settleReject(error);
          if (ws.readyState !== WebSocket.CLOSED) {
            this.intentionallyClosed = true;
            ws.close(1000, "startup failed");
          }
        };

        ws.on("open", () => {
          this.resetRealtimeSessionState();
          this.connected = true;
          this.sessionConfigured = false;
          this.reconnectAttempts = 0;
          this.sendSessionUpdate();
        });

        ws.on("message", (data) => {
          if (settled && !this.sessionConfigured) {
            return;
          }
          try {
            const event = JSON.parse(rawRealtimeMessageToString(data)) as XaiRealtimeEvent;
            if (event.type === "error" && !this.sessionConfigured) {
              rejectStartup(new Error(readRealtimeErrorDetail(event.error)));
              return;
            }
            this.handleEvent(event);
            if (event.type === "session.updated") {
              settleResolve();
            }
          } catch (error) {
            this.config.onError?.(
              error instanceof Error
                ? error
                : new Error(`xAI realtime event parse failed: ${formatError(error)}`),
            );
          }
        });

        ws.on("error", (error) => {
          const normalized = error instanceof Error ? error : new Error(String(error));
          if (!this.sessionConfigured) {
            rejectStartup(normalized);
            return;
          }
          this.config.onError?.(normalized);
        });

        ws.on("close", () => {
          const wasConfigured = this.sessionConfigured;
          this.connected = false;
          this.sessionConfigured = false;
          if (this.intentionallyClosed) {
            settleResolve();
            this.config.onClose?.("completed");
            return;
          }
          if (!wasConfigured && !settled) {
            settleReject(new Error("xAI realtime voice connection closed before ready"));
            return;
          }
          void this.attemptReconnect("websocket-close");
        });
      };

      void this.resolveConnectionParams()
        .then(openWebSocket)
        .catch((error: unknown) => {
          settleReject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private async resolveConnectionParams(): Promise<{
    url: string;
    headers: Record<string, string>;
  }> {
    const cfg = this.config;
    const model = cfg.model ?? XAI_REALTIME_DEFAULT_MODEL;
    const baseUrl = normalizeXaiRealtimeBaseUrl(cfg.baseUrl);
    const apiKey = await resolveXaiRealtimeApiKey({
      configApiKey: cfg.apiKey,
      cfg: cfg.cfg,
    });
    const url = toXaiRealtimeWsUrl({ baseUrl, model });
    return {
      url,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...xaiUserAgentHeaderFor(baseUrl),
      },
    };
  }

  private sendSessionUpdate(): void {
    const cfg = this.config;
    this.sendEvent(
      buildXaiRealtimeSessionUpdate({
        instructions: cfg.instructions,
        voice: cfg.voice,
        audioFormat: this.audioFormat,
        tools: cfg.tools,
        autoRespondToAudio: cfg.autoRespondToAudio,
        vadThreshold: cfg.vadThreshold,
        silenceDurationMs: cfg.silenceDurationMs,
        prefixPaddingMs: cfg.prefixPaddingMs,
        interruptResponseOnInputAudio: cfg.interruptResponseOnInputAudio,
      }),
    );
  }

  private handleEvent(event: XaiRealtimeEvent): void {
    this.config.onEvent?.({
      direction: "server",
      type: event.type,
      itemId: event.item_id ?? event.item?.id,
      responseId: event.response_id ?? event.response?.id,
    });
    switch (event.type) {
      case "session.created":
        return;

      case "session.updated":
        this.sessionConfigured = true;
        for (const chunk of this.pendingAudio.splice(0)) {
          this.sendAudio(chunk);
        }
        if (!this.sessionReadyFired) {
          this.sessionReadyFired = true;
          this.config.onReady?.();
        }
        return;

      case "response.created":
        this.responseActive = true;
        this.responseCreateInFlight = false;
        return;

      case "conversation.output_audio.delta":
      case "response.audio.delta":
      case "response.output_audio.delta": {
        const audioDelta = event.delta ?? event.data;
        if (!audioDelta) {
          return;
        }
        this.config.onAudio(base64ToBuffer(audioDelta));
        if (event.item_id && event.item_id !== this.lastAssistantItemId) {
          this.lastAssistantItemId = event.item_id;
          this.responseStartTimestamp = this.latestMediaTimestamp;
        } else if (this.responseStartTimestamp === null) {
          this.responseStartTimestamp = this.latestMediaTimestamp;
        }
        this.responseActive = true;
        this.sendMark();
        return;
      }

      case "input_audio_buffer.speech_started":
        if (this.config.interruptResponseOnInputAudio ?? this.config.autoRespondToAudio ?? true) {
          this.handleBargeIn();
        }
        return;

      case "conversation.output_transcript.delta":
      case "response.output_text.delta":
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        if (event.delta) {
          this.config.onTranscript?.("assistant", event.delta, false);
        }
        return;

      case "response.output_text.done":
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done": {
        const transcript = event.transcript ?? event.text;
        if (transcript) {
          this.config.onTranscript?.("assistant", transcript, true);
        }
        return;
      }

      case "conversation.input_transcript.delta":
      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          this.config.onTranscript?.("user", event.delta, false);
        }
        return;

      case "conversation.item.input_audio_transcription.updated": {
        const transcript = event.transcript ?? event.text ?? event.delta;
        if (transcript) {
          this.config.onTranscript?.("user", transcript, false);
        }
        return;
      }

      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          this.config.onTranscript?.("user", event.transcript, true);
        }
        return;

      case "response.cancelled":
      case "response.done":
        this.responseActive = false;
        this.responseCreateInFlight = false;
        this.responseCancelInFlight = false;
        this.flushPendingResponseCreate();
        return;

      case "response.function_call_arguments.delta": {
        const key = event.item_id ?? "unknown";
        const existing = this.toolCallBuffers.get(key);
        if (existing && event.delta) {
          existing.args += event.delta;
        } else if (event.item_id) {
          this.toolCallBuffers.set(event.item_id, {
            name: event.name ?? "",
            callId: event.call_id ?? "",
            args: event.delta ?? "",
          });
        }
        return;
      }

      case "response.function_call_arguments.done": {
        const key = event.item_id ?? "unknown";
        const buffered = this.toolCallBuffers.get(key);
        this.emitToolCallOnce({
          itemId: event.item_id,
          callId: buffered?.callId || event.call_id,
          name: buffered?.name || event.name,
          rawArgs: buffered?.args || event.arguments,
        });
        this.toolCallBuffers.delete(key);
        return;
      }

      case "response.output_item.done":
      case "conversation.item.done": {
        if (event.item?.type !== "function_call") {
          return;
        }
        this.emitToolCallOnce({
          itemId: event.item.id ?? event.item_id,
          callId: event.item.call_id ?? event.call_id ?? event.item.id ?? event.item_id,
          name: event.item.name ?? event.name,
          rawArgs: event.item.arguments ?? event.arguments,
        });
        return;
      }

      case "error": {
        const detail = readRealtimeErrorDetail(event.error);
        if (detail.startsWith(XAI_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX)) {
          this.responseActive = true;
          this.responseCreateInFlight = false;
          this.responseCreatePending = true;
          return;
        }
        if (detail === XAI_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR) {
          this.responseActive = false;
          this.responseCancelInFlight = false;
          this.flushPendingResponseCreate();
          return;
        }
        this.config.onError?.(new Error(detail));
      }

      default:
    }
  }

  private emitToolCallOnce(fields: {
    itemId?: string;
    callId?: string;
    name?: string;
    rawArgs?: string;
  }): void {
    if (!this.config.onToolCall) {
      return;
    }
    const itemId = fields.itemId || fields.callId || "unknown";
    const callId = fields.callId || itemId;
    const name = fields.name || "";
    const dedupeKey = fields.itemId || fields.callId || `${name}:${fields.rawArgs ?? ""}`;
    if (this.deliveredToolCallKeys.has(dedupeKey)) {
      return;
    }
    this.deliveredToolCallKeys.add(dedupeKey);
    let args: unknown = {};
    try {
      args = JSON.parse(fields.rawArgs || "{}");
    } catch {}
    this.config.onToolCall({
      itemId,
      callId,
      name,
      args,
    });
  }

  private requestResponseCreate(): void {
    if (
      this.responseActive ||
      this.responseCreateInFlight ||
      this.responseCancelInFlight ||
      this.continuingToolCallIds.size > 0
    ) {
      this.responseCreatePending = true;
      return;
    }
    this.responseCreatePending = false;
    this.responseCreateInFlight = true;
    this.sendEvent({ type: "response.create" });
  }

  private flushPendingResponseCreate(): void {
    if (!this.responseCreatePending || this.continuingToolCallIds.size > 0) {
      return;
    }
    this.responseCreatePending = false;
    this.requestResponseCreate();
  }

  private sendEvent(event: Record<string, unknown>, detail?: string): void {
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    this.config.onEvent?.({
      direction: "client",
      type: typeof event.type === "string" ? event.type : "unknown",
      detail,
      itemId: typeof event.item_id === "string" ? event.item_id : undefined,
      responseId: typeof event.response_id === "string" ? event.response_id : undefined,
    });
    this.ws.send(JSON.stringify(event));
  }

  private sendMark(): void {
    const markName = `xai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.markQueue.push(markName);
    this.config.onMark?.(markName);
  }

  private resetRealtimeSessionState(): void {
    this.markQueue = [];
    this.responseStartTimestamp = null;
    this.responseActive = false;
    this.responseCreateInFlight = false;
    this.responseCancelInFlight = false;
    this.responseCreatePending = false;
    this.continuingToolCallIds.clear();
    this.lastAssistantItemId = null;
    this.toolCallBuffers.clear();
    this.deliveredToolCallKeys.clear();
  }

  private async attemptReconnect(reason: string): Promise<void> {
    if (this.intentionallyClosed) {
      return;
    }
    if (this.reconnectAttempts >= XAI_REALTIME_MAX_RECONNECT_ATTEMPTS) {
      this.config.onEvent?.({
        direction: "client",
        type: "session.reconnect.exhausted",
        detail: `reason=${reason} attempts=${this.reconnectAttempts}`,
      });
      this.config.onClose?.("error");
      return;
    }
    this.reconnectAttempts += 1;
    const attempt = this.reconnectAttempts;
    const delay = XAI_REALTIME_BASE_RECONNECT_DELAY_MS * 2 ** (attempt - 1);
    this.config.onEvent?.({
      direction: "client",
      type: "session.reconnect.scheduled",
      detail: `reason=${reason} attempt=${attempt} delayMs=${delay}`,
    });
    await new Promise((resolve) => {
      setTimeout(resolve, delay);
    });
    if (this.intentionallyClosed) {
      return;
    }
    try {
      await this.doConnect();
      this.config.onEvent?.({
        direction: "client",
        type: "session.reconnect.ready",
        detail: `reason=${reason} attempt=${attempt}`,
      });
    } catch (error) {
      this.config.onError?.(error instanceof Error ? error : new Error(formatError(error)));
      await this.attemptReconnect(reason);
    }
  }
}

async function createXaiRealtimeBrowserSession(
  req: RealtimeVoiceBrowserSessionCreateRequest,
): Promise<RealtimeVoiceBrowserSession> {
  const config = normalizeProviderConfig(req.providerConfig);
  const model = normalizeOptionalString(req.model) ?? config.model ?? XAI_REALTIME_DEFAULT_MODEL;
  const voice = normalizeOptionalString(req.voice) ?? config.voice ?? XAI_REALTIME_DEFAULT_VOICE;
  const baseUrl = normalizeXaiRealtimeBaseUrl(config.baseUrl);
  const apiKey = await resolveXaiRealtimeApiKey({
    configApiKey: config.apiKey,
    cfg: req.cfg,
  });
  const clientSecret = await createXaiRealtimeClientSecret({ apiKey, baseUrl });
  return {
    provider: "xai",
    transport: "provider-websocket",
    protocol: "xai-realtime",
    clientSecret: clientSecret.value,
    websocketUrl: toXaiRealtimeWsUrl({ baseUrl, model }),
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: 24_000,
      outputEncoding: "pcm16",
      outputSampleRateHz: 24_000,
    },
    initialMessage: buildXaiRealtimeSessionUpdate({
      instructions: req.instructions,
      voice,
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      tools: req.tools,
      vadThreshold: req.vadThreshold ?? config.vadThreshold,
      silenceDurationMs: req.silenceDurationMs ?? config.silenceDurationMs,
      prefixPaddingMs: req.prefixPaddingMs ?? config.prefixPaddingMs,
      interruptResponseOnInputAudio: config.interruptResponseOnInputAudio,
    }),
    model,
    voice,
    ...(typeof clientSecret.expiresAt === "number" ? { expiresAt: clientSecret.expiresAt } : {}),
  };
}

export function buildXaiRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    id: "xai",
    label: "xAI Grok Voice",
    defaultModel: XAI_REALTIME_DEFAULT_MODEL,
    models: XAI_REALTIME_MODELS,
    autoSelectOrder: 25,
    capabilities: {
      transports: ["provider-websocket", "gateway-relay"],
      inputAudioFormats: [
        REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      outputAudioFormats: [
        REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      supportsBrowserSession: true,
      supportsBargeIn: true,
      supportsToolCalls: true,
    },
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ cfg, providerConfig }) =>
      Boolean(normalizeProviderConfig(providerConfig).apiKey || process.env.XAI_API_KEY) ||
      isProviderAuthProfileConfigured({ provider: "xai", cfg }),
    createBridge: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      return new XaiRealtimeVoiceBridge({
        ...req,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        voice: config.voice,
        vadThreshold: config.vadThreshold,
        silenceDurationMs: config.silenceDurationMs,
        prefixPaddingMs: config.prefixPaddingMs,
        interruptResponseOnInputAudio:
          req.interruptResponseOnInputAudio ?? config.interruptResponseOnInputAudio,
        minBargeInAudioEndMs: config.minBargeInAudioEndMs,
      });
    },
    createBrowserSession: createXaiRealtimeBrowserSession,
  };
}

export const xaiRealtimeVoiceProviderInternalsForTest = {
  normalizeProviderConfig,
  toXaiRealtimeClientSecretsUrl,
  toXaiRealtimeWsUrl,
};
