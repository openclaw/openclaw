// GPT-Live backend bridge over the Frameless Bidi WebSocket protocol used by Codex realtime v3.
import { randomUUID } from "node:crypto";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import {
  canonicalizeBase64,
  rawDataToString,
  createStreamingPcmResampler,
  mulawToPcm,
  pcmToMulaw,
  RealtimeVoiceSessionLifecycle,
  type RealtimeVoiceBridge,
  type RealtimeVoiceBridgeCreateRequest,
  type RealtimeVoiceSessionConnection,
  type RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice-provider";
import WebSocket, { type RawData } from "ws";
import type { OpenAIRealtimeHost } from "./realtime-host.js";
import { OpenAILiveDelegationQueue } from "./realtime-live-delegation-queue.js";
import { dispatchOpenAIQuicksilverBridgeDelegation } from "./realtime-quicksilver-bridge-delegation.js";
import type { OpenAIQuicksilverTranscriptEntry } from "./realtime-quicksilver-instructions.js";
import {
  captureOpenAIQuicksilverTransportEvent,
  buildOpenAIQuicksilverAudioAppend,
  buildOpenAIQuicksilverContextAppend,
  closeOpenAILiveSocket,
  openAIQuicksilverToolResultText,
} from "./realtime-quicksilver-protocol.js";
import { projectOpenAIQuicksilverErrorMessage } from "./realtime-quicksilver-redaction.js";
import {
  connectOpenAIQuicksilverSideband,
  waitForOpenAIQuicksilverConnectStep,
  type OpenAIQuicksilverSocket,
  type OpenAIQuicksilverSocketFactory,
} from "./realtime-quicksilver-sideband.js";
import { OpenAIQuicksilverTranscript } from "./realtime-quicksilver-transcript.js";
import {
  boundOpenAIQuicksilverDelegationResult,
  buildOpenAIQuicksilverSessionUpdate,
  buildOpenAIQuicksilverWebSocketUrl,
  chunkOpenAIQuicksilverAppendText,
  parseOpenAIQuicksilverEvent,
  type OpenAIQuicksilverAuth,
  type OpenAIQuicksilverInboundEvent,
} from "./realtime-quicksilver-wire.js";
import { isOpenAIGptLiveApiModel } from "./realtime-quicksilver.js";

const OPENAI_QUICKSILVER_READY_TIMEOUT_MS = 15_000;
const PCM_SAMPLE_RATE = 24_000;
const WEBSOCKET_OPEN = 1;

type OpenAIQuicksilverVoiceBridgeConfig = RealtimeVoiceBridgeCreateRequest & {
  model: string;
  voice?: string;
  resolveAuth: () => Promise<OpenAIQuicksilverAuth>;
  logger?: Pick<PluginLogger, "warn">;
  webSocketFactory?: OpenAIQuicksilverSocketFactory;
};

export class OpenAIQuicksilverVoiceBridge implements RealtimeVoiceBridge {
  readonly supportsToolResultContinuation = true;
  readonly supportsToolResultSuppression = true;
  readonly handlesInputAudioBargeIn = false;

  private socket: OpenAIQuicksilverSocket | undefined;
  private closing?: { connection: RealtimeVoiceSessionConnection; completion?: Promise<void> };
  private readonly lifecycle: RealtimeVoiceSessionLifecycle;
  private inboundTelephonyResampler = createStreamingPcmResampler(8_000, PCM_SAMPLE_RATE);
  private outboundTelephonyResampler = createStreamingPcmResampler(PCM_SAMPLE_RATE, 8_000);
  private activeDelegations = new Set<string>();
  private publicDelegations: OpenAILiveDelegationQueue | undefined;
  private readonly transcript = new OpenAIQuicksilverTranscript();
  private readonly requestIds = {
    realtimeSessionId: randomUUID(),
    sessionId: randomUUID(),
    threadId: randomUUID(),
  };

  constructor(
    private readonly config: OpenAIQuicksilverVoiceBridgeConfig,
    private readonly runtime: OpenAIRealtimeHost,
  ) {
    this.lifecycle = new RealtimeVoiceSessionLifecycle("OpenAI", {
      pendingAudioOverflowPolicy: "drop-oldest",
      onPendingAudioOverflow: () =>
        (config.logger?.warn ?? console.warn)(
          "OpenAI GPT-Live input audio queue overflow; keeping newest audio",
        ),
    });
  }

  async connect(): Promise<void> {
    await this.lifecycle.connect((connection) => this.connectConnection(connection));
  }

  private async connectConnection(connection: RealtimeVoiceSessionConnection): Promise<void> {
    let connected: Awaited<ReturnType<typeof connectOpenAIQuicksilverSideband>>;
    try {
      const auth = await waitForOpenAIQuicksilverConnectStep(
        this.config.resolveAuth(),
        connection.signal,
      );
      connected = await connectOpenAIQuicksilverSideband(
        {
          auth,
          createSocket:
            this.config.webSocketFactory ?? ((url, options) => new WebSocket(url, options)),
          requestIds: this.requestIds,
          signal: connection.signal,
          url: buildOpenAIQuicksilverWebSocketUrl(this.config.model),
        },
        this.runtime,
      );
    } catch (error) {
      if (
        !this.lifecycle.isCurrent(connection) ||
        this.lifecycle.terminalOutcome(connection) === "completed"
      ) {
        return;
      }
      this.failLifecycle(connection);
      throw this.redactError(error);
    }
    if (!this.lifecycle.isCurrent(connection) || connection.signal.aborted) {
      this.closeSocket("stale connection", connected.socket);
      return;
    }
    this.socket = connected.socket;
    if (isOpenAIGptLiveApiModel(this.config.model)) {
      this.publicDelegations = new OpenAILiveDelegationQueue({
        isActive: () => this.lifecycle.acceptsEvents(connection),
        readInput: () => this.transcript.latestUserInput(),
        dispatch: (id, input) => this.startDelegation(id, input, connection),
        onExpired: (id) =>
          this.sendContext(
            "Ask the user to repeat their request; no user transcript was received.",
            "speakable",
            id,
          ),
        onError: (error) => this.fail(connection, error),
      });
    }
    captureOpenAIQuicksilverTransportEvent(this.runtime, "local", "ws-open");

    let reachedReady = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    let readySettled = false;
    let removeAbortListener = () => {};
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const settleReady = (providerReady = true) => {
      if (readySettled) {
        return;
      }
      readySettled = true;
      reachedReady = providerReady;
      if (readyTimeout) {
        clearTimeout(readyTimeout);
      }
      removeAbortListener();
      resolveReady();
    };
    const failReady = (error: Error) => {
      if (readySettled) {
        return;
      }
      readySettled = true;
      if (readyTimeout) {
        clearTimeout(readyTimeout);
      }
      removeAbortListener();
      rejectReady(error);
    };
    const failStartup = (error: Error, reason: string) => {
      if (this.lifecycle.terminalOutcome(connection) === "completed") {
        settleReady(false);
        return;
      }
      if (!this.lifecycle.acceptsEvents(connection) || reachedReady) {
        return;
      }
      this.failLifecycle(connection);
      failReady(this.redactError(error));
      this.closeSocket(reason, connected.socket);
    };
    const readyTimeout = setTimeout(() => {
      failStartup(
        new Error("GPT-Live WebSocket did not emit session.started"),
        "session-start timeout",
      );
    }, OPENAI_QUICKSILVER_READY_TIMEOUT_MS);
    readyTimeout.unref?.();
    const onAbort = () => {
      if (this.lifecycle.terminalOutcome(connection) === "completed") {
        settleReady(false);
      }
    };
    connection.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => connection.signal.removeEventListener("abort", onAbort);
    if (connection.signal.aborted) {
      onAbort();
    }

    connected.socket.on("message", (data: RawData, isBinary: boolean) => {
      const draining =
        this.closing?.connection === connection &&
        this.lifecycle.terminalOutcome(connection) === "completed";
      if (
        (!this.lifecycle.acceptsEvents(connection) && !draining) ||
        this.socket !== connected.socket
      ) {
        return;
      }
      if (isBinary && draining) {
        return;
      }
      if (isBinary) {
        const error = new Error("GPT-Live WebSocket returned an unexpected binary frame");
        if (!reachedReady) {
          failStartup(error, "unexpected binary frame");
        } else {
          this.fail(connection, error);
        }
        return;
      }
      const payload = rawDataToString(data);
      captureOpenAIQuicksilverTransportEvent(this.runtime, "inbound", "ws-frame");
      const event = parseOpenAIQuicksilverEvent(payload, this.config.model);
      if (event) {
        if (draining && event.kind !== "transcript-delta" && event.kind !== "transcript-done") {
          return;
        }
        this.handleEvent(event, connection, settleReady, failStartup);
      }
    });
    connected.socket.on("error", (error: Error) => {
      if (!this.lifecycle.acceptsEvents(connection) || this.socket !== connected.socket) {
        return;
      }
      if (!reachedReady) {
        failStartup(error, "startup error");
      } else {
        this.fail(connection, error);
      }
    });
    connected.socket.on("close", (code) => {
      if (!this.lifecycle.isCurrent(connection) || this.socket !== connected.socket) {
        return;
      }
      this.socket = undefined;
      if (!reachedReady) {
        if (this.lifecycle.terminalOutcome(connection) === "completed") {
          settleReady();
          this.notifyClose(connection, "completed");
          return;
        }
        const error = new Error("GPT-Live WebSocket closed before session.started");
        this.failLifecycle(connection);
        failReady(error);
        this.lifecycle.close(connection, "error");
        return;
      }
      if (this.closing?.connection !== connection) {
        this.notifyClose(
          connection,
          code === 1000 && !isOpenAIGptLiveApiModel(this.config.model) ? "completed" : "error",
        );
      }
    });

    const terminalEvent = connected.detachBuffer();
    this.sendEvent(
      buildOpenAIQuicksilverSessionUpdate({
        model: this.config.model,
        instructions: this.config.instructions,
        voice: this.config.voice,
      }),
    );
    for (const frame of connected.bufferedFrames) {
      if (!frame.isBinary) {
        const event = parseOpenAIQuicksilverEvent(rawDataToString(frame.data), this.config.model);
        if (event) {
          this.handleEvent(event, connection, settleReady, failStartup);
        }
      }
    }
    if (terminalEvent) {
      const error =
        terminalEvent.kind === "error"
          ? terminalEvent.error
          : new Error("GPT-Live WebSocket closed during startup");
      if (reachedReady) {
        if (
          terminalEvent.kind === "close" &&
          terminalEvent.code === 1000 &&
          !isOpenAIGptLiveApiModel(this.config.model)
        ) {
          this.notifyClose(connection, "completed");
        } else {
          this.fail(connection, error, "startup terminal event");
        }
      } else {
        failStartup(error, "startup terminal event");
      }
    }
    await readyPromise;
  }

  sendAudio(audio: Buffer): void {
    if (this.lifecycle.phase() === "terminal") {
      return;
    }
    if (!this.lifecycle.isReady() || this.socket?.readyState !== WEBSOCKET_OPEN) {
      this.lifecycle.enqueuePendingAudio(audio);
      return;
    }
    this.sendAudioNow(audio);
  }

  setMediaTimestamp(_ts: number): void {}

  sendUserMessage(text: string): void {
    const channel = isOpenAIGptLiveApiModel(this.config.model) ? "speakable" : undefined;
    this.sendContext(text, channel);
  }

  triggerGreeting(instructions?: string): void {
    this.sendContext(instructions ?? "Greet the user briefly.", "speakable");
  }

  submitToolResult(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void {
    const channel = options?.suppressResponse || options?.willContinue ? "commentary" : "speakable";
    const isDelegation = this.activeDelegations.has(callId);
    const text = openAIQuicksilverToolResultText(result);
    this.sendContext(
      isDelegation ? boundOpenAIQuicksilverDelegationResult(text) : text,
      channel,
      isDelegation ? callId : undefined,
    );
    if (!options?.willContinue) {
      this.activeDelegations.delete(callId);
    }
  }

  acknowledgeMark(_markName?: string): void {}

  close(): void | Promise<void> {
    const connection = this.lifecycle.currentConnection();
    if (!this.lifecycle.cancel()) {
      return this.closing?.connection === connection ? this.closing?.completion : undefined;
    }
    const socket = this.socket;
    const { publication: transcript } = this.transcript.consume();
    this.resetTerminalState();
    if (connection && socket && isOpenAIGptLiveApiModel(this.config.model)) {
      const closing: NonNullable<OpenAIQuicksilverVoiceBridge["closing"]> = { connection };
      this.closing = closing;
      let publicationFailure: { error: unknown } | undefined;
      const completion = closeOpenAILiveSocket(socket)
        .then(
          (reason) =>
            this.notifyClose(
              connection,
              reason === "content" || reason === "connection_lost" ? "error" : "completed",
            ),
          (error: unknown) => {
            this.notifyClose(connection, "error");
            throw error;
          },
        )
        .finally(() => {
          if (publicationFailure) {
            throw publicationFailure.error;
          }
        });
      closing.completion = completion;
      void completion.catch(() =>
        (this.config.logger?.warn ?? console.warn)(
          "GPT-Live cleanup INCOMPLETE: finalization or final cleanup failed",
        ),
      );
      try {
        this.publishTranscriptSnapshots(transcript, connection);
      } catch (error) {
        publicationFailure = { error };
      }
      return completion;
    }
    try {
      this.publishTranscriptSnapshots(transcript, connection);
    } finally {
      if (connection) {
        try {
          if (socket?.readyState === WEBSOCKET_OPEN) {
            socket.send(JSON.stringify({ type: "session.close" }));
          }
        } finally {
          this.closeSocket("bridge closed", socket);
          this.notifyClose(connection, "completed");
        }
      }
    }
  }

  isConnected(): boolean {
    return this.lifecycle.isReady() && this.socket?.readyState === WEBSOCKET_OPEN;
  }

  handleBargeIn(): void {
    // Frameless Bidi owns interruption from incoming audio and exposes no client cancel event.
    this.config.onClearAudio("barge-in");
  }

  private handleEvent(
    event: OpenAIQuicksilverInboundEvent,
    connection: RealtimeVoiceSessionConnection,
    settleReady: () => void,
    failStartup: (error: Error, reason: string) => void,
  ): void {
    if (event.kind === "ignored" || event.kind === "unknown") {
      return;
    }
    if (event.kind === "session-started") {
      if (this.lifecycle.ready(connection)) {
        for (const audio of this.lifecycle.drainPendingAudio()) {
          this.sendAudioNow(audio);
        }
        this.config.onReady?.();
      }
      this.config.onEvent?.({ direction: "server", type: "session.started" });
      settleReady();
      return;
    }
    if (event.kind === "session-closed") {
      if (!this.lifecycle.isReady()) {
        failStartup(new Error("GPT-Live closed before startup"), "session closed");
        return;
      }
      const socket = this.socket;
      try {
        this.notifyClose(
          connection,
          event.reason === "connection_lost" || event.reason === "content" ? "error" : "completed",
        );
      } finally {
        this.closeSocket("session closed", socket);
      }
      return;
    }
    if (event.kind === "audio-cleared") {
      this.config.onEvent?.({ direction: "server", type: "output_audio_buffer.cleared" });
      this.config.onClearAudio("barge-in");
      return;
    }
    if (event.kind === "audio") {
      const canonical = canonicalizeBase64(event.data);
      if (!canonical) {
        this.fail(connection, new Error("GPT-Live WebSocket returned malformed base64 audio"));
        return;
      }
      const pcm = Buffer.from(canonical, "base64");
      const output =
        this.config.audioFormat?.encoding === "g711_ulaw"
          ? pcmToMulaw(this.outboundTelephonyResampler.process(pcm))
          : pcm;
      if (output.length > 0) {
        this.config.onAudio(output);
      }
      this.config.onEvent?.({
        direction: "server",
        type: isOpenAIGptLiveApiModel(this.config.model)
          ? "session.output_audio.delta"
          : "output_audio.delta",
      });
      return;
    }
    if (event.kind === "transcript-delta" || event.kind === "transcript-done") {
      const publicApi = isOpenAIGptLiveApiModel(this.config.model);
      if (publicApi) {
        const draining =
          this.closing?.connection === connection &&
          this.lifecycle.terminalOutcome(connection) === "completed";
        const isCurrent = () => this.lifecycle.isCurrent(connection);
        this.transcript.appendPublic(event, {
          onTranscript: this.config.onTranscript,
          isCurrent,
          canAppend: () => isCurrent() && (draining || this.lifecycle.acceptsEvents(connection)),
        });
      } else {
        this.transcript.append(event);
      }
      if (!this.lifecycle.isCurrent(connection)) {
        return;
      }
      if (
        event.kind === "transcript-done" &&
        event.role === "assistant" &&
        this.config.audioFormat?.encoding === "g711_ulaw"
      ) {
        const tail = pcmToMulaw(this.outboundTelephonyResampler.flush());
        this.outboundTelephonyResampler = createStreamingPcmResampler(PCM_SAMPLE_RATE, 8_000);
        if (tail.length > 0) {
          this.config.onAudio(tail);
        }
      }
      if (!publicApi) {
        this.config.onTranscript?.(event.role, event.text, event.kind === "transcript-done");
      }
      this.config.onEvent?.({
        direction: "server",
        type:
          event.kind === "transcript-done"
            ? event.role === "assistant"
              ? "response.done"
              : "turn.done"
            : publicApi
              ? `session.${event.role === "user" ? "input" : "output"}_transcript.delta`
              : `${event.role === "user" ? "input" : "output"}_transcript.added`,
      });
      this.publicDelegations?.resume();
      return;
    }
    if (event.kind === "delegation") {
      if (this.publicDelegations) {
        this.publicDelegations.enqueue(event.id);
      } else {
        this.startDelegation(
          event.id,
          event.prompt ?? this.transcript.latestUserInput(),
          connection,
          event.prompt,
        );
      }
      return;
    }
    const message = projectOpenAIQuicksilverErrorMessage("provider");
    const error = new Error(message);
    if (!this.lifecycle.isReady()) {
      failStartup(error, "session start failed");
      return;
    }
    const reportEvent = () =>
      this.config.onEvent?.({ direction: "server", type: "error", detail: message });
    if (event.fatalAuth) {
      this.fail(connection, error, "authentication failed", reportEvent);
    } else {
      reportEvent();
      this.config.onError?.(error);
    }
  }

  private startDelegation(
    id: string,
    input: string,
    connection: RealtimeVoiceSessionConnection,
    prompt?: string,
  ): void {
    dispatchOpenAIQuicksilverBridgeDelegation({
      id,
      input,
      prompt,
      model: this.config.model,
      callbacks: this.config,
      transcript: this.transcript,
      activeDelegations: this.activeDelegations,
      isActive: () => this.lifecycle.acceptsEvents(connection),
      isCurrent: () => this.lifecycle.isCurrent(connection),
      sendReply: (message) => this.sendContext(message, "speakable", id),
      onError: (error) => this.fail(connection, error),
    });
  }

  private sendAudioNow(audio: Buffer): void {
    const pcm =
      this.config.audioFormat?.encoding === "g711_ulaw"
        ? this.inboundTelephonyResampler.process(mulawToPcm(audio))
        : audio;
    if (pcm.length === 0) {
      return;
    }
    this.sendEvent(buildOpenAIQuicksilverAudioAppend(this.config.model, pcm.toString("base64")));
  }

  private sendContext(
    text: string,
    channel?: "speakable" | "commentary",
    delegationId?: string,
  ): void {
    if (this.lifecycle.phase() === "terminal") {
      return;
    }
    for (const chunk of chunkOpenAIQuicksilverAppendText(text)) {
      this.sendEvent(
        buildOpenAIQuicksilverContextAppend({
          model: this.config.model,
          text: chunk,
          channel,
          delegationId,
        }),
      );
    }
  }

  private sendEvent(event: object): void {
    if (!this.socket || this.socket.readyState !== WEBSOCKET_OPEN) {
      return;
    }
    const payload = JSON.stringify(event);
    captureOpenAIQuicksilverTransportEvent(this.runtime, "outbound", "ws-frame");
    this.socket.send(payload);
  }

  private fail(
    connection: RealtimeVoiceSessionConnection,
    error: Error,
    reason = "bridge error",
    beforeError?: () => void,
  ): void {
    if (!this.lifecycle.failure(connection)) {
      return;
    }
    const socket = this.socket;
    let drain: { resolve: () => void; reject: (error: unknown) => void } | undefined;
    if (isOpenAIGptLiveApiModel(this.config.model)) {
      const completion = new Promise<void>((resolve, reject) => {
        drain = { resolve, reject };
      });
      this.closing = { connection, completion };
      void completion.catch(() =>
        (this.config.logger?.warn ?? console.warn)("GPT-Live failure cleanup observer failed"),
      );
    }
    try {
      this.notifyClose(connection, "error", () => {
        beforeError?.();
        if (this.lifecycle.isCurrent(connection)) {
          this.config.onError?.(this.redactError(error));
        }
      });
    } catch (failure) {
      drain?.reject(failure);
      throw failure;
    } finally {
      this.closeSocket(reason, socket);
      drain?.resolve();
    }
  }

  private redactError(_error: unknown): Error {
    return new Error(projectOpenAIQuicksilverErrorMessage("transport"));
  }

  private failLifecycle(connection: RealtimeVoiceSessionConnection): void {
    if (this.lifecycle.failure(connection)) {
      this.resetTerminalState();
    }
  }

  private publishTranscriptSnapshots(
    publication: readonly OpenAIQuicksilverTranscriptEntry[],
    connection = this.lifecycle.currentConnection(),
  ): void {
    this.transcript.publish(publication, {
      onTranscript: this.config.onTranscript,
      isCurrent: () => Boolean(connection && this.lifecycle.isCurrent(connection)),
    });
  }

  private resetTerminalState(): void {
    this.publicDelegations?.stop();
    this.publicDelegations = undefined;
    this.activeDelegations.clear();
    this.transcript.clear();
    this.inboundTelephonyResampler = createStreamingPcmResampler(8_000, PCM_SAMPLE_RATE);
    this.outboundTelephonyResampler = createStreamingPcmResampler(PCM_SAMPLE_RATE, 8_000);
  }

  private closeSocket(reason: string, socket = this.socket): void {
    try {
      socket?.close(1000, reason);
    } catch {
      // Closing is best effort once the bridge reaches a terminal state.
    }
  }

  private notifyClose(
    connection: RealtimeVoiceSessionConnection,
    reason: "completed" | "error",
    beforeClose?: () => void,
  ): void {
    const outcome = this.lifecycle.close(connection, reason);
    if (!outcome) {
      return;
    }
    const { publication: transcript } = this.transcript.consume();
    this.resetTerminalState();
    try {
      this.publishTranscriptSnapshots(transcript, connection);
    } finally {
      try {
        if (this.lifecycle.isCurrent(connection)) {
          beforeClose?.();
        }
      } finally {
        if (this.lifecycle.isCurrent(connection)) {
          this.config.onClose?.(reason === "error" ? "error" : outcome);
        }
      }
    }
  }
}
