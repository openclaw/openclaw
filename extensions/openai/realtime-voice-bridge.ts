import type {
  RealtimeVoiceBridge,
  RealtimeVoiceSessionConnection,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  RealtimeVoiceSessionLifecycle,
  RealtimeVoiceWebSocketTransport,
} from "openclaw/plugin-sdk/realtime-voice-provider";
import WebSocket from "ws";
import type { OpenAIRealtimeHost } from "./realtime-host.js";
import {
  readRealtimeErrorDetail,
  resolveOpenAIRealtimeRequestHeaders,
} from "./realtime-provider-shared.js";
import { buildOpenAIRealtimeSidebandUrl } from "./realtime-quicksilver-wire.js";
import {
  OpenAIRealtimeEvents,
  OpenAIRealtimeMalformedAudioError,
} from "./realtime-voice-events.js";
import {
  OPENAI_REALTIME_DEFAULT_MODEL,
  OPENAI_REALTIME_API_KEY_REQUIRED,
  OPENAI_REALTIME_CONFIGURED_API_KEY_REJECTED,
  OPENAI_REALTIME_PLATFORM_AUTH_REQUIRED,
  OPENAI_REALTIME_SIDEBAND_STARTUP_MAX_BYTES,
  OPENAI_VOICE_WS_MAX_PAYLOAD_BYTES,
  hasOpenAIRealtimeConfiguredApiKeyInput,
  isDirectOpenAIRealtimeWebSocketUrl,
  isOpenAIRealtimeStartupAuthFailure,
  requireOpenAIRealtimeApiKey,
  requireOpenAIRealtimePlatformAuth,
  resolveOpenAIRealtimeSecretInput,
  type OpenAIRealtimeUserMessageOptions,
  type OpenAIRealtimeVoiceBridgeConfig,
  type RealtimeEvent,
} from "./realtime-voice-session-policy.js";

const OPENAI_REALTIME_MAX_BUFFERED_AUDIO_BYTES = 1024 * 1024;
const OPENAI_REALTIME_AUDIO_DROP_WARN_INTERVAL_MS = 5_000;

export class OpenAIRealtimeBridge extends OpenAIRealtimeEvents implements RealtimeVoiceBridge {
  private readonly transport: RealtimeVoiceWebSocketTransport<RealtimeEvent>;
  private sessionReadyFired = false;
  private activeConnectionReason: string | undefined;
  private droppedInputAudioFrames = 0;
  private lastInputAudioDropWarningAt = Number.NEGATIVE_INFINITY;

  constructor(config: OpenAIRealtimeVoiceBridgeConfig, runtime: OpenAIRealtimeHost) {
    super(config, runtime);
    this.transport = new RealtimeVoiceWebSocketTransport<RealtimeEvent>({
      providerId: "openai",
      label: "OpenAI realtime",
      callbacks: config,
      lifecycle: new RealtimeVoiceSessionLifecycle("OpenAI", {
        pendingAudioOverflowPolicy: "drop-oldest",
        onPendingAudioOverflow: () =>
          config.logger.warn("OpenAI realtime input audio queue overflow; keeping newest audio"),
      }),
      resolveConnection: () => this.resolveConnectionParams(),
      createSocket: ({ url, headers }) => {
        const proxyAgent = runtime.createDebugProxyWebSocketAgent(
          runtime.resolveDebugProxySettings(),
        );
        return new WebSocket(url, {
          headers,
          maxPayload: OPENAI_VOICE_WS_MAX_PAYLOAD_BYTES,
          ...(proxyAgent ? { agent: proxyAgent } : {}),
        });
      },
      capture: runtime.captureWsEventAsync,
      onOpen: () => {
        this.resetRealtimeSessionState();
        this.sendSessionUpdate();
      },
      onEvent: (event, connection) => this.handleEvent(event, connection),
      onReset: () => this.resetTerminalState(),
      startupError: (error, url) =>
        isDirectOpenAIRealtimeWebSocketUrl(url) && isOpenAIRealtimeStartupAuthFailure(error)
          ? new Error(OPENAI_REALTIME_CONFIGURED_API_KEY_REJECTED)
          : error instanceof Error
            ? error
            : new Error(readRealtimeErrorDetail(error)),
      fatalEventError: (error, event) =>
        event?.type === "session.updated"
          ? { code: 1011, reason: "Readiness callback failed" }
          : error instanceof OpenAIRealtimeMalformedAudioError
            ? { code: 1002, reason: "Malformed audio payload" }
            : undefined,
      startupLimit: {
        bytes: OPENAI_REALTIME_SIDEBAND_STARTUP_MAX_BYTES,
        message: "OpenAI realtime sideband startup buffer exceeded",
        reason: "Sideband startup buffer exceeded",
      },
      closeOnFailedAbort: true,
      onFirstReconnect: () => {
        this.resetRealtimeSessionState();
        config.onEvent?.({ direction: "client", type: "session.continuity.reset" });
      },
      maxReconnectAttempts: 5,
      reconnectDelayMs: 1000,
      connectTimeoutMs: 10_000,
    });
  }

  connect(): Promise<void> {
    return this.transport.connect();
  }

  sendAudio(audio: Buffer): void {
    if (this.transport.lifecycle.phase() === "terminal") {
      return;
    }
    if (
      !this.transport.lifecycle.isReady() ||
      this.transport.socket?.readyState !== WebSocket.OPEN
    ) {
      this.transport.lifecycle.enqueuePendingAudio(audio);
      return;
    }
    if (this.transport.socket.bufferedAmount > OPENAI_REALTIME_MAX_BUFFERED_AUDIO_BYTES) {
      this.droppedInputAudioFrames += 1;
      const now = Date.now();
      if (now - this.lastInputAudioDropWarningAt >= OPENAI_REALTIME_AUDIO_DROP_WARN_INTERVAL_MS) {
        this.config.logger.warn(
          `OpenAI realtime input audio backpressure; droppedFrames=${this.droppedInputAudioFrames}`,
        );
        this.droppedInputAudioFrames = 0;
        this.lastInputAudioDropWarningAt = now;
      }
      return;
    }
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: audio.toString("base64"),
    });
  }

  sendUserMessage(text: string, options?: OpenAIRealtimeUserMessageOptions): void {
    if (options?.toolChoice && (this.responseBusy || this.pendingToolCallIds.size > 0)) {
      throw new Error("Forced realtime tool choice requires an idle response state");
    }
    if (this.pendingToolCallIds.size > 0) {
      // Control/status speech must not wait behind the long-running consult whose
      // function output owns the default conversation response.
      this.standaloneSpeechQueue.push(text);
      this.flushStandaloneSpeech();
      return;
    }
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.requestResponseCreate(options);
  }

  triggerGreeting(instructions?: string): void {
    if (!this.isConnected() || !this.transport.socket) {
      return;
    }
    this.sendUserMessage(instructions ?? this.config.instructions ?? "Greet the meeting.");
  }

  submitToolResult(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void {
    if (this.transport.lifecycle.phase() === "terminal" || !this.pendingToolCallIds.has(callId)) {
      return;
    }
    const output = JSON.stringify(result);
    if (typeof output !== "string") {
      throw new Error("OpenAI realtime voice tool result is not JSON-serializable");
    }
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output,
      },
    });
    if (options?.willContinue === true) {
      this.continuingToolCallIds.add(callId);
      return;
    }
    this.continuingToolCallIds.delete(callId);
    this.pendingToolCallIds.delete(callId);
    if (options?.suppressResponse === true) {
      this.flushPendingResponseCreate();
      return;
    }
    this.requestResponseCreate();
  }

  close(): void {
    this.transport.close();
  }

  isConnected(): boolean {
    return this.transport.isConnected();
  }

  private resolveConnectionParams():
    | { url: string; headers: Record<string, string> }
    | Promise<{ url: string; headers: Record<string, string> }> {
    const cfg = this.config;
    const model = cfg.model ?? OPENAI_REALTIME_DEFAULT_MODEL;
    if (cfg.azureEndpoint && cfg.azureDeployment) {
      const apiKey = requireOpenAIRealtimeApiKey(cfg.apiKey);
      const base = cfg.azureEndpoint
        .replace(/\/$/, "")
        .replace(/^http(s?):/, (_, secure: string) => `ws${secure}:`);
      const apiVersion = cfg.azureApiVersion ?? "2024-10-01-preview";
      const url = `${base}/openai/realtime?api-version=${apiVersion}&deployment=${encodeURIComponent(
        cfg.azureDeployment,
      )}`;
      return {
        url,
        headers: resolveOpenAIRealtimeRequestHeaders(
          this.runtime,
          url,
          { "api-key": apiKey },
          "websocket",
        ),
      };
    }

    if (hasOpenAIRealtimeConfiguredApiKeyInput(cfg.apiKey)) {
      const directApiKey = resolveOpenAIRealtimeSecretInput(cfg.apiKey);
      if (!directApiKey) {
        throw new Error(OPENAI_REALTIME_PLATFORM_AUTH_REQUIRED);
      }
      return this.resolveApiKeyConnectionParams(directApiKey, model);
    }

    if (cfg.azureEndpoint) {
      const directApiKey = resolveOpenAIRealtimeSecretInput(process.env.OPENAI_API_KEY);
      if (!directApiKey) {
        throw new Error(OPENAI_REALTIME_API_KEY_REQUIRED);
      }
      return this.resolveApiKeyConnectionParams(directApiKey, model);
    }

    return this.resolveDefaultConnectionParams(model);
  }

  private async resolveDefaultConnectionParams(model: string): Promise<{
    url: string;
    headers: Record<string, string>;
  }> {
    const auth = await requireOpenAIRealtimePlatformAuth(
      {
        configuredApiKey: this.config.apiKey,
        cfg: this.config.cfg,
        agentId: this.config.agentId,
      },
      this.runtime,
    );
    return this.resolveApiKeyConnectionParams(auth, model);
  }

  private resolveApiKeyConnectionParams(
    apiKey: string,
    model: string,
  ): { url: string; headers: Record<string, string> } {
    const cfg = this.config;
    let url: string;
    if (cfg.baseUrl) {
      const endpoint = new URL(cfg.baseUrl);
      // Signed endpoint queries can depend on the original escaping of other fields.
      const query = endpoint.search
        ? endpoint.search
            .slice(1)
            .split("&")
            .filter((part) => !new URLSearchParams(part).has("model"))
        : [];
      endpoint.search = [...query, `model=${encodeURIComponent(model)}`].join("&");
      url = endpoint.toString();
    } else if (cfg.azureEndpoint) {
      const base = cfg.azureEndpoint
        .replace(/\/$/, "")
        .replace(/^http(s?):/, (_, secure: string) => `ws${secure}:`);
      url = `${base}/v1/realtime?model=${encodeURIComponent(model)}`;
    } else {
      url = cfg.callId
        ? buildOpenAIRealtimeSidebandUrl(cfg.callId)
        : `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    }
    return {
      url,
      headers: resolveOpenAIRealtimeRequestHeaders(
        this.runtime,
        url,
        { Authorization: `Bearer ${apiKey}` },
        "websocket",
      ),
    };
  }

  protected onSessionUpdated(connection: RealtimeVoiceSessionConnection): void {
    if (!this.transport.lifecycle.ready(connection)) {
      return;
    }
    if (this.activeConnectionReason) {
      this.config.onEvent?.({
        direction: "server",
        type: "session.rotation.ready",
        detail: `reason=${this.activeConnectionReason}`,
      });
      this.activeConnectionReason = undefined;
    }
    if (!this.sessionReadyFired) {
      this.sessionReadyFired = true;
      this.config.onReady?.();
    }
    for (const chunk of this.transport.lifecycle.drainPendingAudio()) {
      this.sendAudio(chunk);
    }
  }

  private resetTerminalState(): void {
    // Transport retries preserve readiness and rotation attribution. A terminal
    // session clears both so explicit bridge reuse starts as a new session.
    this.sessionReadyFired = false;
    this.activeConnectionReason = undefined;
    this.resetRealtimeSessionState();
  }

  protected sendEvent(event: { type: string; [key: string]: unknown }, detail?: string): void {
    this.transport.send(event, detail);
  }

  protected acceptsEvent(connection: RealtimeVoiceSessionConnection): boolean {
    return this.transport.lifecycle.acceptsEvents(connection);
  }

  protected isTransportOpen(): boolean {
    return this.transport.socket?.readyState === WebSocket.OPEN;
  }

  protected rotateExpiredSession(): void {
    this.activeConnectionReason = "max-duration";
    this.config.onEvent?.({
      direction: "server",
      type: "session.rotation",
      detail: "reason=max-duration",
    });
    this.transport.rotate("max-duration");
  }

  protected failToolCallSessionLimit(
    error: Error,
    connection: RealtimeVoiceSessionConnection,
  ): void {
    const ws = this.transport.socket;
    if (ws) {
      this.transport.fail(error, connection, {
        code: 1008,
        reason: "Tool-call session limit exceeded",
      });
    }
  }
}
