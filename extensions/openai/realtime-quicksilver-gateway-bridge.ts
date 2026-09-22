// Gateway-owned GPT-Live bridge over released WebRTC and unlisted direct transport.
import { randomUUID } from "node:crypto";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceCloseDisposition,
  RealtimeVoiceCloseOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import WebSocket, { type RawData } from "ws";
import type { OpenAIRealtimeHost } from "./realtime-host.js";
import {
  OpenAIQuicksilverAudioClock,
  OpenAIQuicksilverAudioAdapter,
  OpenAIQuicksilverPendingAudio,
  OPENAI_QUICKSILVER_RELAY_FRAME_BYTES,
} from "./realtime-quicksilver-audio-buffer.js";
import { OpenAIQuicksilverDelegationController } from "./realtime-quicksilver-delegation-controller.js";
import type {
  OpenAIQuicksilverAudioPeerCallbacks,
  OpenAIQuicksilverAudioPeerContract,
} from "./realtime-quicksilver-peer.runtime.js";
import {
  buildOpenAIQuicksilverAudioAppend,
  closeOpenAILiveSocket,
} from "./realtime-quicksilver-protocol.js";
import {
  projectOpenAIQuicksilverAuthErrorMessage,
  projectOpenAIQuicksilverErrorMessage,
} from "./realtime-quicksilver-redaction.js";
import {
  releaseOpenAIQuicksilverSession,
  reserveOpenAIQuicksilverSession,
} from "./realtime-quicksilver-session-limit.js";
import {
  connectOpenAIQuicksilverSideband,
  openAIQuicksilverConnectAbortError,
  waitForOpenAIQuicksilverConnectStep,
  type OpenAIQuicksilverSocket,
  type OpenAIQuicksilverSocketFactory,
} from "./realtime-quicksilver-sideband.js";
import {
  buildOpenAIQuicksilverSession,
  buildOpenAIQuicksilverSessionUpdate,
  buildOpenAIQuicksilverWebSocketUrl,
  createOpenAIQuicksilverCall,
  type OpenAIQuicksilverAuth,
  type OpenAIQuicksilverRequestIds,
} from "./realtime-quicksilver-wire.js";
import {
  isOpenAIGptLiveApiModel,
  isOpenAIGptLiveSubscriptionModel,
} from "./realtime-quicksilver.js";

const RELAY_SAMPLE_RATE = 24_000;
const QUICKSILVER_SESSION_TTL_MS = 30 * 60_000;
const QUICKSILVER_CONNECT_TIMEOUT_MS = 30_000;
const WEBSOCKET_OPEN = 1;

type OpenAIQuicksilverBridgeConfig = RealtimeVoiceBridgeCreateRequest & {
  model: string;
  voice?: string;
  logger: Pick<PluginLogger, "debug" | "warn">;
  resolveAuth: () => Promise<OpenAIQuicksilverAuth>;
  createPeer?: (
    callbacks: OpenAIQuicksilverAudioPeerCallbacks,
    signal: AbortSignal,
  ) => Promise<OpenAIQuicksilverAudioPeerContract>;
  fetchImpl?: typeof fetch;
  webSocketFactory?: OpenAIQuicksilverSocketFactory;
  connectTimeoutMs?: number;
};

type ActiveSideband = {
  socket: OpenAIQuicksilverSocket;
  requestIds: OpenAIQuicksilverRequestIds;
};

type OpenAIQuicksilverGatewayTransport = "direct" | "webrtc";

function normalizeSidebandCloseReason(reason: Buffer | string | undefined): string {
  const text = typeof reason === "string" ? reason : (reason?.toString("utf8") ?? "");
  return text.replaceAll(/\s+/g, " ").trim().slice(0, 180);
}

function describeSidebandClose(code: number, reason: string): string {
  return `OpenAI GPT-Live sideband closed (code ${code}${reason ? `: ${reason}` : ""})`;
}

/** Realtime voice bridge used only when a Gateway relay injects the agent runner. */
export class OpenAIQuicksilverGatewayBridge implements RealtimeVoiceBridge {
  readonly supportsToolResultContinuation = false;
  readonly supportsToolResultSuppression = false;
  readonly handlesInputAudioBargeIn = true;
  readonly outputAudioMode = "continuous";
  readonly pacesInputAudio = true;

  private abortController = new AbortController();
  private connectPromise: Promise<void> | undefined;
  private delegations: OpenAIQuicksilverDelegationController | undefined;
  private connected = false;
  private closed = false;
  private closeNotified = false;
  private closingPromise: Promise<void> | undefined;
  private closeReason: "completed" | "error" = "completed";
  private providerSessionClosed = false;
  private peer: OpenAIQuicksilverAudioPeerContract | undefined;
  private pendingAudio = new OpenAIQuicksilverPendingAudio();
  private readonly audioClock = new OpenAIQuicksilverAudioClock(() => {
    if (!this.ready || this.closed || this.sideband?.socket.readyState !== WEBSOCKET_OPEN) {
      this.audioClock.stop();
      return;
    }
    const frame = Buffer.alloc(OPENAI_QUICKSILVER_RELAY_FRAME_BYTES);
    this.pendingAudio.readInto(frame);
    try {
      this.sendDirectAudio(frame);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("GPT-Live input audio send failed"));
    }
  });
  private ready = false;
  private sideband: ActiveSideband | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private transport: OpenAIQuicksilverGatewayTransport | undefined;
  private readonly audio: OpenAIQuicksilverAudioAdapter;

  constructor(
    private readonly config: OpenAIQuicksilverBridgeConfig,
    private readonly runtime: OpenAIRealtimeHost,
  ) {
    this.audio = new OpenAIQuicksilverAudioAdapter(config);
  }

  connect(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("GPT-Live gateway relay bridge is closed"));
    }
    this.connectPromise ??= this.connectInternal();
    return this.connectPromise;
  }

  sendAudio(audio: Buffer): void {
    if (this.closed) {
      return;
    }
    const pcm = this.audio.decodeInput(audio);
    if (this.peer) {
      this.peer.sendAudio(pcm);
    } else if (!this.closed && !this.abortController.signal.aborted) {
      // Relay capture starts before transport readiness and may recycle its input buffers.
      this.pendingAudio.append(pcm);
    }
  }

  setMediaTimestamp(_ts: number): void {}

  sendUserMessage(text: string): void {
    this.delegations?.sendSessionContext(text, "speakable");
  }

  triggerGreeting(instructions?: string): void {
    this.sendUserMessage(instructions?.trim() || "Greet the user briefly.");
  }

  submitToolResult(): void {
    throw new Error("GPT-Live gateway relay uses provider-owned agent delegations");
  }

  acknowledgeMark(): void {}

  close(options?: RealtimeVoiceCloseOptions): void | Promise<void> {
    return this.teardown("completed", undefined, options?.disposition ?? "abort");
  }

  isConnected(): boolean {
    return this.connected && !this.closed;
  }

  private async connectInternal(): Promise<void> {
    if (!this.config.runAgentConsult) {
      throw new Error("OpenAI GPT-Live gateway relay requires the Gateway agent-consult runtime");
    }
    const audioFormat = this.config.audioFormat;
    if (
      audioFormat &&
      (audioFormat.channels !== 1 ||
        !(
          (audioFormat.encoding === "pcm16" && audioFormat.sampleRateHz === RELAY_SAMPLE_RATE) ||
          (audioFormat.encoding === "g711_ulaw" && audioFormat.sampleRateHz === 8_000)
        ))
    ) {
      throw new Error(
        "OpenAI GPT-Live gateway relay requires mono PCM16 at 24 kHz or G.711 mu-law at 8 kHz",
      );
    }
    reserveOpenAIQuicksilverSession(this);
    const connectSignal = AbortSignal.any([
      this.abortController.signal,
      AbortSignal.timeout(this.config.connectTimeoutMs ?? QUICKSILVER_CONNECT_TIMEOUT_MS),
    ]);
    let auth: OpenAIQuicksilverAuth;
    try {
      auth = await waitForOpenAIQuicksilverConnectStep(this.config.resolveAuth(), connectSignal);
    } catch (error) {
      if (!this.closingPromise) {
        this.releaseResources("abort");
      }
      throw this.redactAdmissionError(error);
    }
    try {
      const requestIds = {
        realtimeSessionId: randomUUID(),
        sessionId: randomUUID(),
        threadId: randomUUID(),
      };
      if (auth.type === "api-key" && !isOpenAIGptLiveSubscriptionModel(this.config.model)) {
        await this.connectDirect(auth, requestIds, connectSignal);
      } else {
        await this.connectWebRtc(auth, requestIds, connectSignal);
      }
      if (this.closed || connectSignal.aborted) {
        throw openAIQuicksilverConnectAbortError(connectSignal);
      }
      this.connected = true;
      if (!this.timer) {
        this.scheduleExpiry(QUICKSILVER_SESSION_TTL_MS);
      }
    } catch (error) {
      if (!this.closingPromise) {
        this.releaseResources("abort");
      }
      throw this.redactError(error);
    }
  }

  private async connectDirect(
    auth: Extract<OpenAIQuicksilverAuth, { type: "api-key" }>,
    requestIds: OpenAIQuicksilverRequestIds,
    connectSignal: AbortSignal,
  ): Promise<void> {
    this.transport = "direct";
    let resolveReady!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    this.delegations = this.createDelegationController({
      onAudio: (audio) => this.audio.sendOutput(audio),
      onSessionStarted: resolveReady,
    });
    const connected = await this.connectSocket(
      auth,
      requestIds,
      buildOpenAIQuicksilverWebSocketUrl(this.config.model),
      connectSignal,
    );
    this.adoptConnectedSocket(connected);
    this.sendSocketEvent(
      buildOpenAIQuicksilverSessionUpdate({
        model: this.config.model,
        hostControlsInput: true,
        instructions: this.config.instructions,
        voice: this.config.voice,
      }),
    );
    await waitForOpenAIQuicksilverConnectStep(readyPromise, connectSignal);
  }

  private async connectWebRtc(
    auth: OpenAIQuicksilverAuth,
    requestIds: OpenAIQuicksilverRequestIds,
    connectSignal: AbortSignal,
  ): Promise<void> {
    this.transport = "webrtc";
    this.delegations = this.createDelegationController();
    const createPeer =
      this.config.createPeer ??
      (async (callbacks: OpenAIQuicksilverAudioPeerCallbacks, signal: AbortSignal) => {
        const { OpenAIQuicksilverAudioPeer } =
          await import("./realtime-quicksilver-peer.runtime.js");
        return await OpenAIQuicksilverAudioPeer.create({ callbacks, signal });
      });
    const peerPromise = createPeer(
      {
        onAudio: (audio) => this.audio.sendOutput(audio),
        onError: (error) => this.fail(error),
        onMediaError: () => this.config.logger.debug?.("GPT-Live WebRTC media packet dropped"),
        onRtpPacket: () => this.config.onEvent?.({ direction: "server", type: "output_audio.rtp" }),
      },
      connectSignal,
    );
    // A factory can finish after the deadline. Close that late peer because the
    // timed-out connect path can no longer adopt or release it synchronously.
    void peerPromise.then(
      (peer) => {
        if (connectSignal.aborted || this.closed) {
          peer.close();
        }
      },
      () => undefined,
    );
    this.peer = await waitForOpenAIQuicksilverConnectStep(peerPromise, connectSignal);
    if (this.pendingAudio.length > 0) {
      const pendingAudio = this.pendingAudio;
      // Detach synchronously before adoption so bridge teardown can only clear
      // the new owner and no capture can interleave with the transfer.
      this.pendingAudio = new OpenAIQuicksilverPendingAudio();
      this.peer.adoptPendingAudio(pendingAudio);
    }
    const offerSdp = await waitForOpenAIQuicksilverConnectStep(
      this.peer.createOffer(),
      connectSignal,
    );
    const call = await waitForOpenAIQuicksilverConnectStep(
      createOpenAIQuicksilverCall(
        {
          auth,
          requestIds,
          sdp: offerSdp,
          session: buildOpenAIQuicksilverSession({
            model: this.config.model,
            hostControlsInput: Boolean(this.config.handleDelegationInput),
            instructions: this.config.instructions,
            voice: this.config.voice,
          }),
          signal: connectSignal,
          fetchImpl: this.config.fetchImpl,
        },
        this.runtime,
      ),
      connectSignal,
    );
    if (call.kind !== "gpt-live") {
      throw new Error("GPT-Live gateway relay unexpectedly used the GA realtime call shape");
    }
    await waitForOpenAIQuicksilverConnectStep(this.peer.applyAnswer(call.answerSdp), connectSignal);
    const connected = await this.connectSocket(auth, requestIds, call.sidebandUrl, connectSignal);
    this.adoptConnectedSocket(connected);
  }

  private async connectSocket(
    auth: OpenAIQuicksilverAuth,
    requestIds: OpenAIQuicksilverRequestIds,
    url: string,
    connectSignal: AbortSignal,
  ): Promise<Awaited<ReturnType<typeof connectOpenAIQuicksilverSideband>>> {
    const createSocket =
      this.config.webSocketFactory ??
      ((socketUrl: string, options: Parameters<OpenAIQuicksilverSocketFactory>[1]) =>
        new WebSocket(socketUrl, options));
    const connected = await connectOpenAIQuicksilverSideband(
      {
        auth,
        createSocket,
        requestIds,
        signal: connectSignal,
        url,
      },
      this.runtime,
    );
    if (connectSignal.aborted) {
      connected.socket.close(1000, "session stopped");
      throw connectSignal.reason;
    }
    this.sideband = { socket: connected.socket, requestIds };
    this.attachSidebandHandlers(connected.socket);
    return connected;
  }

  private adoptConnectedSocket(
    connected: Awaited<ReturnType<typeof connectOpenAIQuicksilverSideband>>,
  ): void {
    const terminalEvent = connected.detachBuffer();
    for (const frame of connected.bufferedFrames) {
      this.handleSidebandFrame(frame.data, frame.isBinary);
    }
    if (terminalEvent?.kind === "error") {
      throw terminalEvent.error;
    }
    if (terminalEvent?.kind === "close") {
      const reason = normalizeSidebandCloseReason(terminalEvent.reason);
      throw new Error(describeSidebandClose(terminalEvent.code, reason));
    }
  }

  private createDelegationController(params?: {
    onAudio?: (audio: Buffer) => void;
    onSessionStarted?: () => void;
  }): OpenAIQuicksilverDelegationController {
    const runAgentConsult = this.config.runAgentConsult;
    if (!runAgentConsult) {
      throw new Error("OpenAI GPT-Live gateway relay requires the Gateway agent-consult runtime");
    }
    return new OpenAIQuicksilverDelegationController(
      {
        getSocket: () => this.sideband?.socket,
        logger: this.config.logger,
        model: this.config.model,
        onError: this.config.onError,
        onFatalError: (error) => this.fail(error),
        onSessionClosed: (reason) => {
          this.providerSessionClosed = true;
          if (reason === "content" || reason === "connection_lost") {
            this.closeReason = "error";
          }
          void this.teardown(
            reason === "content" || reason === "connection_lost" ? "error" : "completed",
          );
        },
        ...(params?.onAudio ? { onAudio: params.onAudio } : {}),
        onSessionStarted: (expiresAt) => {
          if (expiresAt !== undefined) {
            this.scheduleExpiry(
              Math.min(QUICKSILVER_SESSION_TTL_MS, Math.max(0, expiresAt * 1000 - Date.now())),
            );
          }
          if (!this.ready) {
            this.connected = true;
            this.ready = true;
            if (this.transport === "direct") {
              this.audioClock.start();
            }
            if (this.closed) {
              return;
            }
            this.config.onReady?.();
          }
          params?.onSessionStarted?.();
        },
        onTranscript: (role, text, done) => this.config.onTranscript?.(role, text, done),
        handleDelegationInput: this.config.handleDelegationInput,
        onWireEventType: (eventType) => {
          this.config.onEvent?.({ direction: "server", type: eventType });
          if (eventType === "output_audio_buffer.cleared") {
            this.audio.reset();
            this.config.onClearAudio("barge-in");
          }
        },
        runAgentConsult,
        signal: this.abortController.signal,
      },
      this.runtime.formatErrorMessage,
    );
  }

  private sendDirectAudio(audio: Buffer): void {
    this.sendSocketEvent(
      buildOpenAIQuicksilverAudioAppend(this.config.model, audio.toString("base64")),
    );
  }

  private sendSocketEvent(event: object): void {
    const socket = this.sideband?.socket;
    if (socket?.readyState === WEBSOCKET_OPEN) {
      socket.send(JSON.stringify(event));
    }
  }

  private attachSidebandHandlers(socket: OpenAIQuicksilverSocket): void {
    socket.on("message", (data, isBinary) => this.handleSidebandFrame(data, isBinary));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", (code, rawReason) => {
      const closeCode = code ?? 1006;
      const reason = normalizeSidebandCloseReason(rawReason);
      if (!this.closed) {
        if (isOpenAIGptLiveApiModel(this.config.model) && !this.providerSessionClosed) {
          this.fail(new Error("GPT-Live transport ended without session.closed"));
        } else if (closeCode === 1000) {
          void this.teardown("completed");
        } else {
          this.fail(new Error(describeSidebandClose(closeCode, reason)));
        }
      }
    });
  }

  private handleSidebandFrame(data: RawData, isBinary: boolean): void {
    this.delegations?.handleFrame(data, isBinary);
  }

  private scheduleExpiry(ttlMs: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(
      () => {
        void this.teardown("completed");
      },
      Math.max(0, ttlMs),
    );
    this.timer.unref?.();
  }

  private fail(error: Error): void {
    const redactedError = this.redactError(error);
    void this.teardown("error", () => this.config.onError?.(redactedError));
  }

  private redactError(error: unknown): Error {
    const projected = new Error(projectOpenAIQuicksilverErrorMessage("gateway"));
    if (error instanceof Error && error.name === "TimeoutError") {
      projected.name = "TimeoutError";
    }
    return projected;
  }

  private redactAdmissionError(error: unknown): Error {
    const projected = new Error(projectOpenAIQuicksilverAuthErrorMessage(error));
    if (error instanceof Error && error.name === "TimeoutError") {
      projected.name = "TimeoutError";
    }
    return projected;
  }

  private teardown(
    reason: "completed" | "error",
    beforeClose?: () => void,
    disposition: RealtimeVoiceCloseDisposition = "abort",
  ): void | Promise<void> {
    if (this.closed) {
      return this.closingPromise;
    }
    this.closed = true;
    this.audioClock.stop();
    this.closeReason = reason;
    const socket = this.sideband?.socket;
    if (
      socket?.readyState === WEBSOCKET_OPEN &&
      isOpenAIGptLiveApiModel(this.config.model) &&
      !this.providerSessionClosed
    ) {
      this.delegations?.beginTranscriptDrain(disposition);
      this.connected = false;
      this.ready = false;
      this.pendingAudio.clear();
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
      if (this.providerSessionClosed) {
        this.finishClose(disposition, beforeClose);
        return;
      }
      this.closingPromise = closeOpenAILiveSocket(socket)
        .then((receiptReason) => {
          if (receiptReason === "content" || receiptReason === "connection_lost") {
            this.closeReason = "error";
          }
        })
        .catch((error: unknown) => {
          this.closeReason = "error";
          throw error;
        })
        .finally(() => this.finishClose(disposition, beforeClose));
      void this.closingPromise.catch(() => {
        this.config.logger.warn(
          "GPT-Live cleanup INCOMPLETE: finalization or final cleanup failed",
        );
      });
      return this.closingPromise;
    }
    this.finishClose(disposition, beforeClose);
  }

  private finishClose(disposition: RealtimeVoiceCloseDisposition, beforeClose?: () => void): void {
    try {
      this.delegations?.flushTranscript();
    } finally {
      this.releaseResources(disposition);
      try {
        beforeClose?.();
      } finally {
        if (!this.closeNotified) {
          this.closeNotified = true;
          this.config.onClose?.(this.closeReason);
        }
      }
    }
  }

  private releaseResources(disposition: RealtimeVoiceCloseDisposition): void {
    this.audioClock.stop();
    releaseOpenAIQuicksilverSession(this);
    this.connected = false;
    this.ready = false;
    this.transport = undefined;
    this.pendingAudio.clear();
    this.audio.reset();
    if (disposition === "detach") {
      this.delegations?.detach();
    } else {
      this.delegations?.stop(new Error("GPT-Live delegation stopped"));
    }
    this.abortController.abort(new Error("GPT-Live gateway relay bridge closed"));
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const socket = this.sideband?.socket;
    this.sideband = undefined;
    if (
      socket?.readyState === WEBSOCKET_OPEN &&
      !this.providerSessionClosed &&
      !this.closingPromise
    ) {
      try {
        socket.send(JSON.stringify({ type: "session.close" }));
      } catch {
        // The sideband may close between readyState and send.
      }
    }
    try {
      socket?.close(1000, "session closed");
    } catch {
      // Socket teardown follows ownership release and is best effort.
    }
    this.peer?.close();
    this.peer = undefined;
  }
}
