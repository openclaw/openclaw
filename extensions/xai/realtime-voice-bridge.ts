import * as proxyCaptureSdk from "openclaw/plugin-sdk/proxy-capture";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceSessionConnection,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  RealtimeVoiceSessionLifecycle,
  RealtimeVoiceWebSocketTransport,
} from "openclaw/plugin-sdk/realtime-voice-provider";
import { resolveXaiRealtimeApiKey } from "./realtime-voice-auth.runtime.js";
import {
  XAI_REALTIME_BASE_RECONNECT_DELAY_MS,
  XAI_REALTIME_CONNECT_TIMEOUT_MS,
  XAI_REALTIME_DEFAULT_MODEL,
  XAI_REALTIME_MAX_PENDING_TOOL_RESULTS,
  XAI_REALTIME_MAX_PENDING_USER_MESSAGES,
  XAI_REALTIME_MAX_RECONNECT_ATTEMPTS,
  XAI_REALTIME_WS_MAX_PAYLOAD_BYTES,
  readXaiRealtimeErrorDetail,
  serializeXaiRealtimeToolResult,
  toXaiRealtimeWsUrl,
  type XaiRealtimeEvent,
  type XaiRealtimeVoiceBridgeConfig,
} from "./realtime-voice-config.js";
import { XaiRealtimeMalformedAudioError, XaiRealtimeVoiceEvents } from "./realtime-voice-events.js";
import { XaiRealtimePlaybackMarkOverflowError } from "./realtime-voice-protocol.js";
import { xaiUserAgentHeaderFor } from "./src/xai-user-agent.js";
import { WebSocket } from "./ws-runtime.js";

export class XaiRealtimeVoiceBridge extends XaiRealtimeVoiceEvents implements RealtimeVoiceBridge {
  readonly supportsToolResultContinuation = false;

  private readonly transport: RealtimeVoiceWebSocketTransport<XaiRealtimeEvent>;
  private pendingToolResults: Array<{
    callId: string;
    output: string;
    options?: RealtimeVoiceToolResultOptions;
  }> = [];
  private pendingUserMessages: string[] = [];
  private sessionReadyFired = false;

  constructor(config: XaiRealtimeVoiceBridgeConfig) {
    super(config);
    this.transport = new RealtimeVoiceWebSocketTransport<XaiRealtimeEvent>({
      providerId: "xai",
      label: "xAI realtime voice",
      callbacks: config,
      lifecycle: new RealtimeVoiceSessionLifecycle("xAI"),
      resolveConnection: () => this.resolveConnectionParams(),
      createSocket: ({ url, headers }) => {
        const proxyAgent = proxyCaptureSdk.createDebugProxyWebSocketAgent(
          proxyCaptureSdk.resolveDebugProxySettings(),
        );
        return new WebSocket(url, {
          headers,
          maxPayload: XAI_REALTIME_WS_MAX_PAYLOAD_BYTES,
          ...(proxyAgent ? { agent: proxyAgent } : {}),
        });
      },
      capture: proxyCaptureSdk.captureWsEventAsync,
      onOpen: () => {
        this.resetRealtimeSessionState({
          preserveToolCallState: config.sessionResumption === true && this.conversationId !== null,
        });
        this.sendEvent(this.buildSessionUpdate());
      },
      onEvent: (event, connection) => this.handleEvent(event, connection),
      onReset: () => this.resetTerminalState(),
      startupError: (error) =>
        error instanceof Error ? error : new Error(readXaiRealtimeErrorDetail(error)),
      fatalEventError: (error) =>
        error instanceof XaiRealtimeMalformedAudioError
          ? { code: 1002, reason: "Malformed audio payload" }
          : error instanceof XaiRealtimePlaybackMarkOverflowError
            ? { code: 1002, reason: "Playback mark overflow" }
            : undefined,
      reconnectBlocked: () => this.reconnectBlockReason(),
      maxReconnectAttempts: XAI_REALTIME_MAX_RECONNECT_ATTEMPTS,
      reconnectDelayMs: XAI_REALTIME_BASE_RECONNECT_DELAY_MS,
      connectTimeoutMs: XAI_REALTIME_CONNECT_TIMEOUT_MS,
    });
  }

  connect(): Promise<void> {
    return this.transport.connect();
  }

  sendAudio(audio: Buffer): void {
    if (this.transport.lifecycle.phase() === "terminal") {
      return;
    }
    if (!this.isConnected()) {
      this.transport.lifecycle.enqueuePendingAudio(audio);
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
    if (this.transport.lifecycle.phase() === "terminal") {
      return;
    }
    if (!this.isConnected()) {
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

  triggerGreeting(instructions?: string): void {
    if (this.isConnected() && this.transport.socket) {
      this.sendUserMessage(instructions ?? this.config.instructions ?? "Greet the user.");
    }
  }

  submitToolResult(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void {
    if (this.transport.lifecycle.phase() === "terminal" || options?.willContinue === true) {
      return;
    }
    const connected = this.isConnected();
    let output: string;
    try {
      output = serializeXaiRealtimeToolResult(result);
    } catch (error) {
      if (!connected) {
        this.config.onError?.(error as Error);
      }
      throw error;
    }
    if (!connected) {
      if (this.pendingToolResults.length >= XAI_REALTIME_MAX_PENDING_TOOL_RESULTS) {
        const error = new Error(
          "xAI realtime voice pending tool result queue overflow during reconnect",
        );
        this.config.onError?.(error);
        throw error;
      }
      this.pendingToolResults.push({
        callId,
        output,
        ...(options ? { options } : {}),
      });
      return;
    }
    this.submitToolResultNow(callId, output, options);
  }

  close(): void {
    this.transport.close();
  }

  isConnected(): boolean {
    return this.transport.isConnected();
  }

  private async resolveConnectionParams(): Promise<{
    url: string;
    headers: Record<string, string>;
  }> {
    const apiKey = this.config.resolveApiKey
      ? await this.config.resolveApiKey()
      : await resolveXaiRealtimeApiKey(this.config.apiKey, this.config.cfg, this.config.agentId);
    const model = this.config.model ?? XAI_REALTIME_DEFAULT_MODEL;
    const url = toXaiRealtimeWsUrl(
      this.config.baseUrl,
      model,
      this.config.sessionResumption === true ? (this.conversationId ?? undefined) : undefined,
    );
    return {
      url,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...xaiUserAgentHeaderFor(this.config.baseUrl),
      },
    };
  }

  private reconnectBlockReason(): string | undefined {
    if (this.config.sessionResumption !== true) {
      return "sessionResumption=false";
    }
    if (this.pendingToolResultAcks.size > 0) {
      // xAI has no replay-complete event, so retrying an unacknowledged output
      // could duplicate a side effect at the recovery boundary.
      return `unacknowledgedToolResults=${this.pendingToolResultAcks.size}`;
    }
    if (!this.conversationId) {
      return "missingConversationId=true";
    }
    return undefined;
  }

  protected acceptsEvent(connection: RealtimeVoiceSessionConnection): boolean {
    return this.transport.lifecycle.acceptsEvents(connection);
  }

  protected onSessionUpdated(connection: RealtimeVoiceSessionConnection): void {
    if (!this.transport.lifecycle.ready(connection)) {
      return;
    }
    for (const chunk of this.transport.lifecycle.drainPendingAudio()) {
      this.sendAudio(chunk);
    }
    for (const pending of this.pendingToolResults.splice(0)) {
      this.submitToolResultNow(pending.callId, pending.output, pending.options);
    }
    for (const message of this.pendingUserMessages.splice(0)) {
      this.sendUserMessageNow(message);
    }
    if (!this.sessionReadyFired) {
      this.sessionReadyFired = true;
      this.config.onReady?.();
    }
  }

  protected sendEvent(event: unknown, detail?: string): void {
    this.transport.send(event, detail);
  }

  private resetTerminalState(): void {
    this.pendingToolResults = [];
    this.pendingUserMessages = [];
    this.conversationId = null;
    this.resetRealtimeSessionState();
  }
}
