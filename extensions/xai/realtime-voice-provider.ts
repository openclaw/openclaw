// Xai provider module implements Grok realtime voice bridge integration.
import { randomUUID } from "node:crypto";
import {
  isProviderAuthProfileConfigured,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  captureWsEvent,
  createDebugProxyWebSocketAgent,
  resolveDebugProxySettings,
} from "openclaw/plugin-sdk/proxy-capture";
import type {
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBargeInOptions,
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
} from "openclaw/plugin-sdk/realtime-voice";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asFiniteNumber,
  normalizeOptionalString,
  parseBooleanValue as readBoolean,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import WebSocket from "ws";
import { XAI_BASE_URL } from "./model-definitions.js";
import { xaiUserAgentHeaderFor } from "./src/xai-user-agent.js";

type XaiRealtimeVoice = "eve" | "ara" | "rex" | "sal" | "leo";

type XaiRealtimeVoiceProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  interruptResponseOnInputAudio?: boolean;
  reasoningEffort?: string;
  sessionResumption?: boolean;
};

type XaiRealtimeVoiceBridgeConfig = RealtimeVoiceBridgeCreateRequest & {
  apiKey?: string;
  baseUrl: string;
  model?: string;
  voice?: string;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  interruptResponseOnInputAudio?: boolean;
  reasoningEffort?: string;
  sessionResumption?: boolean;
  resolveApiKey?: () => Promise<string>;
};

type RealtimeEvent = {
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
  conversation?: {
    id?: string;
  };
  error?: unknown;
};

type XaiRealtimeAudioFormatConfig =
  | {
      type: "audio/pcm";
      rate: 24000;
    }
  | {
      type: "audio/pcmu";
    };

type XaiRealtimeSessionUpdate = {
  type: "session.update";
  session: {
    instructions?: string;
    voice?: string;
    output_modalities?: string[];
    turn_detection?: {
      type: "server_vad";
      threshold?: number;
      prefix_padding_ms?: number;
      silence_duration_ms?: number;
      create_response?: boolean;
      interrupt_response?: boolean;
    };
    audio: {
      input: {
        format: XaiRealtimeAudioFormatConfig;
        transcription: { model: string };
      };
      output: {
        format: XaiRealtimeAudioFormatConfig;
      };
    };
    reasoning?: { effort: string };
    resumption?: {
      enabled: boolean;
    };
    tools?: RealtimeVoiceBridgeCreateRequest["tools"];
    tool_choice?: string;
  };
};

const XAI_REALTIME_DEFAULT_MODEL = "grok-voice-latest";
const XAI_REALTIME_CONNECT_TIMEOUT_MS = 10_000;
const XAI_REALTIME_MAX_RECONNECT_ATTEMPTS = 5;
const XAI_REALTIME_BASE_RECONNECT_DELAY_MS = 1000;
const XAI_REALTIME_MAX_PENDING_TOOL_RESULTS = 128;
const XAI_REALTIME_MAX_PENDING_USER_MESSAGES = 128;
const XAI_REALTIME_DEFAULT_VAD_THRESHOLD = 0.85;
const XAI_REALTIME_DEFAULT_PREFIX_PADDING_MS = 333;
const XAI_REALTIME_DEFAULT_SILENCE_DURATION_MS = 500;
const XAI_REALTIME_INPUT_TRANSCRIPTION_MODEL = "grok-transcribe";
const XAI_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX =
  "Conversation already has an active response in progress:";
const XAI_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR =
  "Cancellation failed: no active response found";
const XAI_REALTIME_VOICES = [
  "eve",
  "ara",
  "rex",
  "sal",
  "leo",
] as const satisfies readonly XaiRealtimeVoice[];

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readNestedXaiConfig(rawConfig: RealtimeVoiceProviderConfig) {
  const raw = readRecord(rawConfig);
  const providers = readRecord(raw?.providers);
  return readRecord(providers?.xai ?? raw?.xai ?? raw) ?? {};
}

function normalizeXaiRealtimeBaseUrl(value?: string): string {
  return normalizeOptionalString(value ?? process.env.XAI_BASE_URL) ?? XAI_BASE_URL;
}

function normalizeXaiRealtimeVoice(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const lower = normalized.toLowerCase();
  return XAI_REALTIME_VOICES.includes(lower as XaiRealtimeVoice)
    ? (lower as XaiRealtimeVoice)
    : normalized;
}

function asXaiVadThreshold(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  return number !== undefined && number >= 0.1 && number <= 0.9 ? number : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  return number !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function normalizeProviderConfig(
  config: RealtimeVoiceProviderConfig,
): XaiRealtimeVoiceProviderConfig {
  const raw = readNestedXaiConfig(config);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw.apiKey,
      path: "plugins.entries.voice-call.config.realtime.providers.xai.apiKey",
    }),
    baseUrl: normalizeOptionalString(raw.baseUrl),
    model: normalizeOptionalString(raw.model),
    voice: normalizeXaiRealtimeVoice(raw.speakerVoice ?? raw.voice),
    vadThreshold: asXaiVadThreshold(raw.vadThreshold),
    silenceDurationMs: asNonNegativeInteger(raw.silenceDurationMs),
    prefixPaddingMs: asNonNegativeInteger(raw.prefixPaddingMs),
    interruptResponseOnInputAudio: readBoolean(raw.interruptResponseOnInputAudio),
    reasoningEffort: normalizeOptionalString(raw.reasoningEffort),
    sessionResumption: readBoolean(raw.sessionResumption),
  };
}

function readRealtimeErrorDetail(error: unknown): string {
  if (typeof error === "string" && error) {
    return error;
  }
  const record = readRecord(error);
  const message = normalizeOptionalString(record?.message);
  const code = normalizeOptionalString(record?.code);
  return message ?? code ?? "xAI realtime voice error";
}

function base64ToBuffer(b64: string): Buffer {
  return Buffer.from(b64, "base64");
}

function toXaiRealtimeWsUrl(baseUrl: string, model: string, conversationId?: string): string {
  const url = new URL(normalizeXaiRealtimeBaseUrl(baseUrl));
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/realtime`;
  url.searchParams.set("model", model);
  if (conversationId) {
    url.searchParams.set("conversation_id", conversationId);
  }
  return url.toString();
}

async function resolveXaiRealtimeApiKey(
  configApiKey: string | undefined,
  cfg: OpenClawConfig | undefined,
): Promise<string> {
  const direct =
    normalizeOptionalString(configApiKey) ?? normalizeOptionalString(process.env.XAI_API_KEY);
  if (direct) {
    return direct;
  }
  const auth = await resolveApiKeyForProvider({ provider: "xai", cfg });
  const oauthKey = normalizeOptionalString(auth?.apiKey);
  if (oauthKey) {
    return oauthKey;
  }
  throw new Error(
    "xAI credentials missing for realtime voice. Sign in with `openclaw onboard --auth-choice xai-oauth`, run `openclaw onboard --auth-choice xai-api-key`, or set XAI_API_KEY.",
  );
}

function hasXaiRealtimeApiKeyInput(
  configApiKey: string | undefined,
  cfg: OpenClawConfig | undefined,
): boolean {
  if (normalizeOptionalString(configApiKey) || normalizeOptionalString(process.env.XAI_API_KEY)) {
    return true;
  }
  return isProviderAuthProfileConfigured({ provider: "xai", cfg });
}

class XaiRealtimeVoiceBridge implements RealtimeVoiceBridge {
  private static readonly DEFAULT_MODEL = XAI_REALTIME_DEFAULT_MODEL;
  readonly supportsToolResultContinuation = false;

  private ws: WebSocket | null = null;
  private connected = false;
  private sessionConfigured = false;
  private intentionallyClosed = false;
  private reconnectAttempts = 0;
  private pendingAudio: Buffer[] = [];
  private pendingToolResults: Array<{
    callId: string;
    result: unknown;
    options?: RealtimeVoiceToolResultOptions;
  }> = [];
  private pendingUserMessages: string[] = [];
  private markQueue: string[] = [];
  private responseStartTimestamp: number | null = null;
  private responseActive = false;
  private responseCreateInFlight = false;
  private responseCancelInFlight = false;
  private responseCreatePending = false;
  private continuingToolCallIds = new Set<string>();
  private pendingToolCallIds = new Set<string>();
  private latestMediaTimestamp = 0;
  private lastAssistantItemId: string | null = null;
  private assistantTranscriptBuffer = "";
  private assistantTranscriptFinalized = false;
  private inputTranscriptReplacements = new Map<string, string>();
  private connectionUrl = "";
  private toolCallBuffers = new Map<string, { name: string; callId: string; args: string }>();
  private deliveredToolCallKeys = new Set<string>();
  private readonly flowId = randomUUID();
  private sessionReadyFired = false;
  private conversationId: string | null = null;
  private readonly audioFormat: RealtimeVoiceAudioFormat;

  constructor(private readonly config: XaiRealtimeVoiceBridgeConfig) {
    this.audioFormat = config.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ;
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
    if (!this.canSubmitInput()) {
      if (this.pendingUserMessages.length < XAI_REALTIME_MAX_PENDING_USER_MESSAGES) {
        this.pendingUserMessages.push(text);
      } else {
        this.config.onError?.(
          new Error("xAI realtime voice pending user message queue overflow during reconnect"),
        );
      }
      return;
    }
    this.sendUserMessageNow(text);
  }

  private sendUserMessageNow(text: string): void {
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
    if (!this.canSubmitToolResult()) {
      if (this.pendingToolResults.length < XAI_REALTIME_MAX_PENDING_TOOL_RESULTS) {
        this.pendingToolResults.push({ callId, result, ...(options ? { options } : {}) });
      } else {
        this.config.onError?.(
          new Error("xAI realtime voice pending tool result queue overflow during reconnect"),
        );
      }
      return;
    }
    this.submitToolResultNow(callId, result, options);
  }

  private submitToolResultNow(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void {
    if (options?.willContinue === true) {
      return;
    }
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
    this.continuingToolCallIds.delete(callId);
    this.pendingToolCallIds.delete(callId);
    if (options?.suppressResponse === true) {
      return;
    }
    this.flushPendingResponseCreateAfterToolResults();
  }

  acknowledgeMark(): void {
    if (this.markQueue.length === 0) {
      return;
    }
    this.markQueue.shift();
    if (this.markQueue.length === 0) {
      this.flushPendingResponseCreate();
    }
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

  handleBargeIn(options?: RealtimeVoiceBargeInOptions): void {
    const assistantItemId = this.lastAssistantItemId;
    const responseStartTimestamp = this.responseStartTimestamp;
    const outputInterruptible =
      responseStartTimestamp !== null &&
      (this.responseActive || this.markQueue.length > 0 || options?.audioPlaybackActive === true);
    const shouldInterruptProvider = assistantItemId !== null && outputInterruptible;
    const audioEndMs = shouldInterruptProvider
      ? Math.max(
          0,
          responseStartTimestamp === null
            ? this.latestMediaTimestamp
            : this.latestMediaTimestamp - responseStartTimestamp,
        )
      : null;
    if (this.responseActive && !this.responseCancelInFlight) {
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
    this.markQueue = [];
  }

  private appendAssistantTranscriptDelta(delta: string): void {
    if (this.assistantTranscriptFinalized) {
      this.assistantTranscriptBuffer = "";
      this.assistantTranscriptFinalized = false;
    }
    this.assistantTranscriptBuffer += delta;
    this.config.onTranscript?.("assistant", delta, false);
  }

  private flushAssistantTranscript(finalTranscript?: string): void {
    if (this.assistantTranscriptFinalized) {
      return;
    }
    const transcript = finalTranscript || this.assistantTranscriptBuffer;
    if (transcript) {
      this.config.onTranscript?.("assistant", transcript, true);
      this.assistantTranscriptFinalized = true;
    }
    this.assistantTranscriptBuffer = "";
  }

  private resetAssistantTranscript(): void {
    this.assistantTranscriptBuffer = "";
    this.assistantTranscriptFinalized = false;
  }

  private async doConnect(): Promise<void> {
    const apiKey = this.config.resolveApiKey
      ? await this.config.resolveApiKey()
      : await resolveXaiRealtimeApiKey(this.config.apiKey, this.config.cfg);
    const model = this.config.model ?? XaiRealtimeVoiceBridge.DEFAULT_MODEL;
    const url = toXaiRealtimeWsUrl(
      this.config.baseUrl,
      model,
      this.config.sessionResumption === true ? this.conversationId ?? undefined : undefined,
    );
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      ...xaiUserAgentHeaderFor(this.config.baseUrl),
    };

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let startupFailureClosing = false;
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
      const connectTimeout: ReturnType<typeof setTimeout> = setTimeout(() => {
        if (!this.sessionConfigured && !this.intentionallyClosed) {
          startupFailureClosing = true;
          this.ws?.terminate();
          settleReject(new Error("xAI realtime voice connection timeout"));
        }
      }, XAI_REALTIME_CONNECT_TIMEOUT_MS);

      if (this.intentionallyClosed) {
        settleResolve();
        return;
      }

      this.connectionUrl = url;
      const debugProxy = resolveDebugProxySettings();
      const proxyAgent = createDebugProxyWebSocketAgent(debugProxy);
      const ws = new WebSocket(url, {
        headers,
        ...(proxyAgent ? { agent: proxyAgent } : {}),
      });
      this.ws = ws;

      const rejectStartup = (error: Error) => {
        startupFailureClosing = true;
        settleReject(error);
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.close(1000, "startup failed");
        }
      };

      ws.on("open", () => {
        this.resetRealtimeSessionState({
          preserveToolCallState:
            this.config.sessionResumption === true && this.conversationId !== null,
        });
        this.connected = true;
        this.sessionConfigured = false;
        captureWsEvent({
          url,
          direction: "local",
          kind: "ws-open",
          flowId: this.flowId,
          meta: {
            provider: "xai",
            capability: "realtime-voice",
          },
        });
        this.sendSessionUpdate();
      });

      ws.on("message", (data: Buffer) => {
        if (settled && !this.sessionConfigured) {
          return;
        }
        captureWsEvent({
          url,
          direction: "inbound",
          kind: "ws-frame",
          flowId: this.flowId,
          payload: data,
          meta: {
            provider: "xai",
            capability: "realtime-voice",
          },
        });
        try {
          const event = JSON.parse(data.toString()) as RealtimeEvent;
          if (event.type === "error" && !this.sessionConfigured) {
            rejectStartup(new Error(readRealtimeErrorDetail(event.error)));
            return;
          }
          this.handleEvent(event);
          if (event.type === "session.updated") {
            settleResolve();
          }
        } catch (error) {
          console.error("[xai] realtime event parse failed:", error);
        }
      });

      ws.on("error", (error) => {
        captureWsEvent({
          url,
          direction: "local",
          kind: "error",
          flowId: this.flowId,
          errorText: error instanceof Error ? error.message : String(error),
          meta: {
            provider: "xai",
            capability: "realtime-voice",
          },
        });
        if (!this.sessionConfigured) {
          rejectStartup(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      });

      ws.on("close", (code, reasonBuffer) => {
        captureWsEvent({
          url,
          direction: "local",
          kind: "ws-close",
          flowId: this.flowId,
          closeCode: typeof code === "number" ? code : undefined,
          meta: {
            provider: "xai",
            capability: "realtime-voice",
            reason:
              Buffer.isBuffer(reasonBuffer) && reasonBuffer.length > 0
                ? reasonBuffer.toString("utf8")
                : undefined,
          },
        });
        if (startupFailureClosing) {
          if (this.ws === ws) {
            this.connected = false;
            this.sessionConfigured = false;
          }
          return;
        }
        const wasSessionConfigured = this.sessionConfigured;
        this.connected = false;
        this.sessionConfigured = false;
        if (this.intentionallyClosed) {
          settleResolve();
          this.config.onClose?.("completed");
          return;
        }
        if (!wasSessionConfigured && !settled) {
          settleReject(new Error("xAI realtime voice connection closed before ready"));
          return;
        }
        void this.attemptReconnect("websocket-close");
      });
    });
  }

  private async attemptReconnect(reason: string): Promise<void> {
    if (this.intentionallyClosed) {
      return;
    }
    if (this.config.sessionResumption !== true) {
      this.config.onEvent?.({
        direction: "client",
        type: "session.reconnect.blocked",
        detail: `reason=${reason} sessionResumption=false`,
      });
      this.config.onClose?.("error");
      return;
    }
    if (!this.conversationId) {
      this.config.onEvent?.({
        direction: "client",
        type: "session.reconnect.blocked",
        detail: `reason=${reason} missingConversationId=true`,
      });
      this.config.onClose?.("error");
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
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      await this.attemptReconnect(reason);
    }
  }

  private sendSessionUpdate(): void {
    this.sendEvent(this.buildSessionUpdate());
  }

  private buildSessionUpdate(): XaiRealtimeSessionUpdate {
    const cfg = this.config;
    const autoRespondToAudio = cfg.autoRespondToAudio ?? true;
    const interruptResponseOnInputAudio = cfg.interruptResponseOnInputAudio ?? autoRespondToAudio;
    const voice = cfg.voice ?? "eve";
    return {
      type: "session.update",
      session: {
        instructions: cfg.instructions,
        voice,
        output_modalities: ["audio"],
        turn_detection: {
          type: "server_vad",
          threshold: cfg.vadThreshold ?? XAI_REALTIME_DEFAULT_VAD_THRESHOLD,
          prefix_padding_ms: cfg.prefixPaddingMs ?? XAI_REALTIME_DEFAULT_PREFIX_PADDING_MS,
          silence_duration_ms: cfg.silenceDurationMs ?? XAI_REALTIME_DEFAULT_SILENCE_DURATION_MS,
          create_response: autoRespondToAudio,
          interrupt_response: interruptResponseOnInputAudio,
        },
        audio: {
          input: {
            format: this.resolveRealtimeAudioFormat(),
            transcription: { model: XAI_REALTIME_INPUT_TRANSCRIPTION_MODEL },
          },
          output: {
            format: this.resolveRealtimeAudioFormat(),
          },
        },
        ...(cfg.sessionResumption === true ? { resumption: { enabled: true } } : {}),
        ...(cfg.reasoningEffort ? { reasoning: { effort: cfg.reasoningEffort } } : {}),
        ...(cfg.tools && cfg.tools.length > 0
          ? {
              tools: cfg.tools,
              tool_choice: "auto",
            }
          : {}),
      },
    };
  }

  private resolveRealtimeAudioFormat(): XaiRealtimeAudioFormatConfig {
    return this.audioFormat.encoding === "pcm16"
      ? { type: "audio/pcm", rate: 24000 }
      : { type: "audio/pcmu" };
  }

  private handleEvent(event: RealtimeEvent): void {
    const emitServerEvent = () =>
      this.config.onEvent?.({
        direction: "server",
        type: event.type,
        detail: this.describeServerEvent(event),
        ...(event.item_id ? { itemId: event.item_id } : {}),
        ...((event.response_id ?? event.response?.id)
          ? { responseId: event.response_id ?? event.response?.id }
          : {}),
      });
    emitServerEvent();
    switch (event.type) {
      case "session.created":
        return;

      case "conversation.created": {
        const conversationId = normalizeOptionalString(event.conversation?.id);
        if (conversationId) {
          this.conversationId = conversationId;
        }
        return;
      }

      case "session.updated":
        this.sessionConfigured = true;
        this.reconnectAttempts = 0;
        for (const chunk of this.pendingAudio.splice(0)) {
          this.sendAudio(chunk);
        }
        for (const pendingToolResult of this.pendingToolResults.splice(0)) {
          this.submitToolResultNow(
            pendingToolResult.callId,
            pendingToolResult.result,
            pendingToolResult.options,
          );
        }
        for (const pendingUserMessage of this.pendingUserMessages.splice(0)) {
          this.sendUserMessageNow(pendingUserMessage);
        }
        if (!this.sessionReadyFired) {
          this.sessionReadyFired = true;
          this.config.onReady?.();
        }
        return;

      case "response.created":
        this.responseActive = true;
        this.responseCreateInFlight = false;
        this.markQueue = [];
        this.lastAssistantItemId = null;
        this.responseStartTimestamp = null;
        this.resetAssistantTranscript();
        return;

      case "conversation.output_audio.delta":
      case "response.audio.delta":
      case "response.output_audio.delta": {
        const audioDelta = event.delta ?? event.data;
        if (!audioDelta) {
          return;
        }
        const audio = base64ToBuffer(audioDelta);
        this.config.onAudio(audio);
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
          this.appendAssistantTranscriptDelta(event.delta);
        }
        return;

      case "response.output_text.done":
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done":
        this.flushAssistantTranscript(event.transcript ?? event.text);
        return;

      case "conversation.input_transcript.delta":
      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          this.config.onTranscript?.("user", event.delta, false);
        }
        return;

      case "conversation.item.input_audio_transcription.updated":
        if (event.transcript) {
          this.inputTranscriptReplacements.set(this.inputTranscriptKey(event), event.transcript);
        }
        return;

      case "conversation.item.input_audio_transcription.completed":
        {
          const key = this.inputTranscriptKey(event);
          const transcript = event.transcript ?? this.inputTranscriptReplacements.get(key);
          this.inputTranscriptReplacements.delete(key);
          if (transcript) {
            this.config.onTranscript?.("user", transcript, true);
          }
        }
        return;

      case "response.cancelled":
        this.resetAssistantTranscript();
        this.responseActive = false;
        this.responseCreateInFlight = false;
        this.responseCancelInFlight = false;
        this.flushPendingResponseCreate();
        return;

      case "response.done":
        this.flushAssistantTranscript();
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
    this.pendingToolCallIds.add(callId);
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

  private flushPendingResponseCreateAfterToolResults(): void {
    if (this.pendingToolCallIds.size > 0 || this.continuingToolCallIds.size > 0) {
      this.responseCreatePending = true;
      return;
    }
    this.requestResponseCreate();
  }

  private requestResponseCreate(): void {
    if (
      this.responseActive ||
      this.responseCreateInFlight ||
      this.responseCancelInFlight ||
      this.markQueue.length > 0 ||
      this.continuingToolCallIds.size > 0 ||
      this.pendingToolCallIds.size > 0
    ) {
      this.responseCreatePending = true;
      return;
    }
    this.responseCreatePending = false;
    this.responseCreateInFlight = true;
    this.sendEvent({ type: "response.create" });
  }

  private flushPendingResponseCreate(): void {
    if (!this.responseCreatePending) {
      return;
    }
    this.responseCreatePending = false;
    this.requestResponseCreate();
  }

  private resetRealtimeSessionState(options: { preserveToolCallState?: boolean } = {}): void {
    this.markQueue = [];
    this.responseStartTimestamp = null;
    this.responseActive = false;
    this.responseCreateInFlight = false;
    this.responseCancelInFlight = false;
    this.responseCreatePending = false;
    this.lastAssistantItemId = null;
    this.inputTranscriptReplacements.clear();
    if (!options.preserveToolCallState) {
      this.continuingToolCallIds.clear();
      this.pendingToolCallIds.clear();
      this.toolCallBuffers.clear();
      this.deliveredToolCallKeys.clear();
    }
  }

  private inputTranscriptKey(event: RealtimeEvent): string {
    return event.item_id ?? event.response_id ?? "default";
  }

  private sendMark(): void {
    const markName = `audio-${Date.now()}`;
    this.markQueue.push(markName);
    this.config.onMark?.(markName);
  }

  private sendEvent(event: unknown, detail?: string): void {
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      const type =
        event && typeof event === "object" && typeof (event as { type?: unknown }).type === "string"
          ? (event as { type: string }).type
          : "unknown";
      this.config.onEvent?.({ direction: "client", type, ...(detail ? { detail } : {}) });
      const payload = JSON.stringify(event);
      captureWsEvent({
        url: this.connectionUrl,
        direction: "outbound",
        kind: "ws-frame",
        flowId: this.flowId,
        payload,
        meta: {
          provider: "xai",
          capability: "realtime-voice",
        },
      });
      ws.send(payload);
    }
  }

  private canSendEvent(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private canSubmitToolResult(): boolean {
    return this.connected && this.sessionConfigured && this.canSendEvent();
  }

  private canSubmitInput(): boolean {
    return this.connected && this.sessionConfigured && this.canSendEvent();
  }

  private describeServerEvent(event: RealtimeEvent): string | undefined {
    if (event.type === "error") {
      return readRealtimeErrorDetail(event.error);
    }
    if (event.type === "response.done") {
      const status = event.response?.status;
      const details =
        event.response?.status_details === undefined
          ? undefined
          : JSON.stringify(event.response.status_details);
      return (
        [status ? `status=${status}` : undefined, details].filter(Boolean).join(" ") || undefined
      );
    }
    if (event.type === "response.cancelled") {
      return "cancelled";
    }
    if (event.type === "conversation.item.done" && event.item?.type) {
      return [event.item.type, event.item.name ? `name=${event.item.name}` : undefined]
        .filter(Boolean)
        .join(" ");
    }
    return undefined;
  }
}

export function buildXaiRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    id: "xai",
    label: "xAI Grok Voice",
    aliases: ["xai-realtime-voice", "grok-voice"],
    defaultModel: XAI_REALTIME_DEFAULT_MODEL,
    autoSelectOrder: 25,
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
      supportsBargeIn: true,
      supportsToolCalls: true,
    },
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ providerConfig, cfg }) =>
      hasXaiRealtimeApiKeyInput(normalizeProviderConfig(providerConfig).apiKey, cfg),
    createBridge: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      return new XaiRealtimeVoiceBridge({
        ...req,
        apiKey: config.apiKey,
        baseUrl: normalizeXaiRealtimeBaseUrl(config.baseUrl),
        model: config.model,
        voice: config.voice,
        vadThreshold: config.vadThreshold,
        silenceDurationMs: config.silenceDurationMs,
        prefixPaddingMs: config.prefixPaddingMs,
        interruptResponseOnInputAudio:
          req.interruptResponseOnInputAudio ?? config.interruptResponseOnInputAudio,
        reasoningEffort: config.reasoningEffort,
        sessionResumption: config.sessionResumption,
        resolveApiKey: () => resolveXaiRealtimeApiKey(config.apiKey, req.cfg),
      });
    },
  };
}
