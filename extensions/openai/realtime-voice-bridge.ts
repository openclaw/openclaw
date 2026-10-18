import type {
  RealtimeVoiceBridge,
  RealtimeVoiceSessionConnection,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  normalizeRealtimeVoiceResponseOutcome,
  RealtimeVoiceSessionLifecycle,
  RealtimeVoiceWebSocketTransport,
} from "openclaw/plugin-sdk/realtime-voice-provider";
import {
  asOptionalObjectRecord,
  isRecord,
  readStringField,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import WebSocket from "ws";
import type { OpenAIRealtimeHost } from "./realtime-host.js";
import {
  readRealtimeErrorDetail,
  resolveOpenAIRealtimeRequestHeaders,
} from "./realtime-provider-shared.js";
import { buildOpenAIRealtimeSidebandUrl } from "./realtime-quicksilver-wire.js";
import { base64ToBuffer, OpenAIRealtimeMalformedAudioError } from "./realtime-voice-audio.js";
import { OpenAIRealtimeProtocol } from "./realtime-voice-protocol.js";
import {
  OPENAI_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX,
  OPENAI_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR,
  OPENAI_REALTIME_DEFAULT_MODEL,
  OPENAI_REALTIME_API_KEY_REQUIRED,
  OPENAI_REALTIME_CONFIGURED_API_KEY_REJECTED,
  OPENAI_REALTIME_PLATFORM_AUTH_REQUIRED,
  OPENAI_REALTIME_SIDEBAND_STARTUP_MAX_BYTES,
  OPENAI_VOICE_WS_MAX_PAYLOAD_BYTES,
  hasOpenAIRealtimeConfiguredApiKeyInput,
  isDirectOpenAIRealtimeWebSocketUrl,
  isOpenAIRealtimeMaxSessionDurationError,
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

export class OpenAIRealtimeBridge extends OpenAIRealtimeProtocol implements RealtimeVoiceBridge {
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

  protected handleEvent(event: RealtimeEvent, connection: RealtimeVoiceSessionConnection): void {
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
    if (
      event.type === "error" &&
      isOpenAIRealtimeMaxSessionDurationError(readRealtimeErrorDetail(event.error))
    ) {
      this.rotateExpiredSession();
      return;
    }
    if (event.type === "response.done") {
      this.handleResponseDone(event, connection, emitServerEvent);
      return;
    }
    if (event.type === "response.cancelled") {
      try {
        emitServerEvent();
      } finally {
        this.releaseResponseState();
      }
      return;
    }
    if (event.type === "response.created") {
      // Publish the response owner before observers can interrupt its first PCM.
      this.outputAudioGeneration += 1;
      this.responseActive = true;
      this.responseCreateState = "idle";
    }
    const audioGeneration = this.outputAudioGeneration;
    emitServerEvent();
    if (!this.acceptsEvent(connection)) {
      return;
    }
    switch (event.type) {
      case "session.created":
        return;

      case "session.updated": {
        this.onSessionUpdated(connection);
        return;
      }

      case "conversation.output_audio.delta":
      case "response.audio.delta":
      case "response.output_audio.delta": {
        const audioDelta = event.delta ?? event.data;
        if (
          !audioDelta ||
          this.responseCancelInFlight ||
          audioGeneration !== this.outputAudioGeneration
        ) {
          return;
        }
        const audio = base64ToBuffer(audioDelta);
        if (event.item_id && event.item_id !== this.assistantAudioItem?.itemId) {
          this.assistantAudioItem = {
            itemId: event.item_id,
            bytes: audio.byteLength,
            startTimestamp: this.latestMediaTimestamp,
          };
        } else if (this.assistantAudioItem) {
          // Playback clocks can lead provider output, but truncate cannot exceed item audio.
          this.assistantAudioItem.bytes += audio.byteLength;
        }
        this.responseActive = true;
        const generation = this.outputAudioGeneration;
        const markName = this.createPlaybackMark();
        this.config.onAudio(audio, event.item_id ? { itemId: event.item_id } : undefined);
        if (generation === this.outputAudioGeneration && this.acceptsEvent(connection)) {
          this.config.onMark?.(markName, () => {
            if (this.acceptsEvent(connection)) {
              this.acknowledgeMark(markName);
            }
          });
        }
        return;
      }

      case "input_audio_buffer.speech_started":
        if (this.config.interruptResponseOnInputAudio ?? this.config.autoRespondToAudio ?? true) {
          this.handleBargeIn();
        }
        return;

      case "conversation.output_transcript.delta":
      case "response.text.delta":
      case "response.output_text.delta":
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        if (event.delta) {
          this.config.onTranscript?.("assistant", event.delta, false);
        }
        return;

      case "response.text.done":
      case "response.output_text.done":
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done":
        {
          const transcript = event.transcript ?? event.text;
          if (transcript) {
            this.config.onTranscript?.("assistant", transcript, true);
          }
        }
        return;

      case "conversation.input_transcript.delta":
      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          this.config.onTranscript?.("user", event.delta, false);
        }
        return;

      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          this.config.onTranscript?.("user", event.transcript, true);
        }
        return;

      case "conversation.item.input_audio_transcription.failed":
        this.config.onError?.(new Error(readRealtimeErrorDetail(event.error)));
        break;

      case "conversation.item.added":
        break;

      case "response.function_call_arguments.delta":
      case "response.function_call_arguments.done":
      case "conversation.item.done":
        // These events are provisional and can also arrive for interrupted,
        // incomplete, or cancelled responses. Successful response.done output
        // is the sole execution boundary.
        return;

      case "error": {
        const detail = readRealtimeErrorDetail(event.error);
        const error = isRecord(event.error) ? event.error : undefined;
        // Validation errors can omit event_id. The response parameter still belongs
        // to our single pending create; an explicit id always overrides that evidence.
        const rejectedEventId =
          readStringField(asOptionalObjectRecord(event.error), "event_id") ??
          (this.responseCreateState === "in-flight" &&
          error?.type === "invalid_request_error" &&
          typeof error.param === "string" &&
          (error.param === "response" || error.param.startsWith("response."))
            ? (this.manualResponseCreateEventId ?? this.standaloneSpeechEventId)
            : undefined);
        const rejectsStandaloneSpeech =
          this.standaloneSpeechEventId !== null && rejectedEventId === this.standaloneSpeechEventId;
        const rejectsManualResponseCreate =
          this.manualResponseCreateEventId !== null &&
          rejectedEventId === this.manualResponseCreateEventId;
        if (
          rejectsManualResponseCreate &&
          detail.startsWith(OPENAI_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX)
        ) {
          this.responseActive = true;
          this.responseCreateState = "idle";
          this.manualResponseCreateEventId = null;
          this.responseCreatePending = true;
          return;
        }
        const rejectsManualResponseCancel =
          this.manualResponseCancelEventId !== null &&
          readStringField(asOptionalObjectRecord(event.error), "event_id") ===
            this.manualResponseCancelEventId;
        if (detail === OPENAI_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR) {
          if (!rejectsManualResponseCancel) {
            return;
          }
          this.responseActive = false;
          this.responseCancelInFlight = false;
          this.manualResponseCancelEventId = null;
          if (this.responseCreatePending) {
            this.flushPendingResponseCreate();
          } else {
            this.restoreAutoRespondAfterManualResponse();
          }
          return;
        }
        if (rejectsManualResponseCreate || rejectsStandaloneSpeech) {
          // Rejected creates never emit response.done. Retire the same response owner
          // so transports release speech and reentrant callbacks drain only afterward.
          this.handleResponseDone(
            {
              type: "response.done",
              response: { status: "failed", status_details: { error: event.error } },
            },
            connection,
            () => this.config.onError?.(new Error(detail)),
          );
          return;
        }
        this.config.onError?.(new Error(detail));
      }

      default:
    }
  }

  private handleCompletedResponse(
    event: RealtimeEvent,
    connection: RealtimeVoiceSessionConnection,
  ): boolean {
    if (
      event.response?.status !== "completed" ||
      !Array.isArray(event.response.output) ||
      !this.config.onToolCall
    ) {
      return false;
    }
    for (const output of event.response.output) {
      if (!this.acceptsEvent(connection) || !this.isTransportOpen()) {
        return true;
      }
      if (
        !isRecord(output) ||
        output.type !== "function_call" ||
        (output.status !== undefined && output.status !== "completed")
      ) {
        continue;
      }
      const itemId = typeof output.id === "string" ? output.id.trim() || undefined : undefined;
      const callId = typeof output.call_id === "string" ? output.call_id.trim() : "";
      const name = typeof output.name === "string" ? output.name.trim() : "";
      if (!callId || !name || this.completedToolCallIds.has(callId)) {
        continue;
      }
      if (this.completedToolCallIds.size >= OpenAIRealtimeProtocol.MAX_COMPLETED_TOOL_CALL_IDS) {
        this.failToolCallSessionLimit(
          new Error(
            `OpenAI realtime tool-call session limit exceeded (${OpenAIRealtimeProtocol.MAX_COMPLETED_TOOL_CALL_IDS})`,
          ),
          connection,
        );
        return true;
      }
      this.completedToolCallIds.add(callId);
      this.pendingToolCallIds.add(callId);
      const rejectArguments = (
        reason: string,
        message = "Invalid tool arguments: expected a JSON object.",
      ) => {
        this.config.onEvent?.({
          direction: "server",
          type: "tool_call.arguments.rejected",
          detail: `reason=${reason}`,
          itemId,
        });
        this.submitToolResult(callId, { error: message });
      };
      if (typeof output.arguments !== "string") {
        rejectArguments("invalid-json-type");
        continue;
      }
      const rawArgs = output.arguments;
      if (Buffer.byteLength(rawArgs, "utf8") > OpenAIRealtimeProtocol.MAX_TOOL_ARGUMENT_BYTES) {
        rejectArguments(
          "too-large",
          `Realtime tool arguments exceed the ${OpenAIRealtimeProtocol.MAX_TOOL_ARGUMENT_BYTES}-byte UTF-8 limit`,
        );
        continue;
      }
      let args: unknown;
      try {
        args = JSON.parse(rawArgs || "{}");
      } catch {
        rejectArguments("malformed-json");
        continue;
      }
      if (!isRecord(args)) {
        rejectArguments("non-object-json");
        continue;
      }
      this.config.onToolCall({ itemId: itemId ?? callId, callId, name, args });
    }
    return false;
  }

  private handleResponseDone(
    event: RealtimeEvent,
    connection: RealtimeVoiceSessionConnection,
    emitServerEvent: () => void,
  ): void {
    const outcome = normalizeRealtimeVoiceResponseOutcome({
      providerLabel: "OpenAI realtime voice",
      response: event.response,
      responseId: event.response_id,
    });
    let callbackError: unknown;
    let providerTerminated = false;
    const invoke = (callback: () => void) => {
      try {
        callback();
      } catch (error) {
        callbackError ??= error;
      }
    };
    try {
      // Terminal output still belongs to this response until observers retire its owner.
      invoke(() => {
        providerTerminated = this.handleCompletedResponse(event, connection);
      });
      invoke(() => this.config.onResponseDone?.(outcome));
      invoke(emitServerEvent);
    } finally {
      // response.done owns response state regardless of observer success. A fatal tool
      // boundary still clears state, but must not start queued work on a closing socket.
      const canDrain =
        !providerTerminated && this.acceptsEvent(connection) && this.isTransportOpen();
      this.releaseResponseState({ drain: canDrain });
    }
    if (callbackError) {
      throw callbackError instanceof Error
        ? callbackError
        : new Error("OpenAI realtime response callback failed", { cause: callbackError });
    }
  }

  private describeServerEvent(event: RealtimeEvent): string | undefined {
    if (
      event.type === "error" ||
      event.type === "conversation.item.input_audio_transcription.failed"
    ) {
      return readRealtimeErrorDetail(event.error);
    }
    if (event.type === "session.created" || event.type === "session.updated") {
      const session = isRecord(event.session) ? event.session : undefined;
      const tools = Array.isArray(session?.tools) ? session.tools.length : 0;
      const rawToolChoice = session?.tool_choice;
      const toolChoice =
        typeof rawToolChoice === "string"
          ? rawToolChoice
          : isRecord(rawToolChoice) && typeof rawToolChoice.type === "string"
            ? rawToolChoice.type
            : "unset";
      return `tools=${tools} toolChoice=${toolChoice}`;
    }
    if (
      (event.type === "conversation.item.added" || event.type === "conversation.item.done") &&
      event.item?.type
    ) {
      return [
        `itemType=${event.item.type}`,
        event.item.name ? `name=${event.item.name}` : undefined,
      ]
        .filter(Boolean)
        .join(" ");
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
    return undefined;
  }
}
