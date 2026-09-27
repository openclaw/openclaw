// Gateway-owned GPT-Live bridge over released WebRTC and unlisted direct transport.
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type {
  RealtimeVoiceAudioOutputPort,
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceCloseDisposition,
  RealtimeVoiceCloseOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import WebSocket, { type RawData } from "ws";
import type { OpenAIRealtimeHost } from "./realtime-host.js";
import {
  assertOpenAIQuicksilverPcmOutput,
  OpenAIQuicksilverAudioAdapter,
  OpenAIQuicksilverPendingAudio,
} from "./realtime-quicksilver-audio-buffer.js";
import { OpenAIQuicksilverDelegationController } from "./realtime-quicksilver-delegation-controller.js";
import type {
  OpenAIQuicksilverAudioPeerCallbacks,
  OpenAIQuicksilverAudioPeerContract,
} from "./realtime-quicksilver-peer.runtime.js";
import { closeOpenAILiveSocket } from "./realtime-quicksilver-protocol.js";
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
  loadOpenAIQuicksilverMediaSocketFactory,
  openAIQuicksilverConnectAbortError,
  waitForOpenAIQuicksilverConnectStep,
} from "./realtime-quicksilver-sideband.js";
import {
  type OpenAIQuicksilverSocket,
  type OpenAIQuicksilverSocketFactory,
  QuicksilverSocketAudioQueue,
  type QuicksilverMediaSocket,
  type QuicksilverMediaSocketFactory,
} from "./realtime-quicksilver-socket.shared.js";
import {
  buildOpenAIQuicksilverSession,
  buildOpenAIQuicksilverSessionUpdate,
  buildOpenAIQuicksilverWebSocketUrl,
  createOpenAIQuicksilverCall,
  createOpenAIQuicksilverRequestIds,
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
  mediaSocketFactory?: QuicksilverMediaSocketFactory;
  connectTimeoutMs?: number;
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
  private audioOutput: RealtimeVoiceAudioOutputPort | undefined;
  private pendingAudio = new OpenAIQuicksilverPendingAudio();
  private readonly pendingRawAudio: QuicksilverSocketAudioQueue;
  private directSocket: QuicksilverMediaSocket | undefined;
  private ready = false;
  private sideband: OpenAIQuicksilverSocket | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private transport: OpenAIQuicksilverGatewayTransport | undefined;
  private readonly audio: OpenAIQuicksilverAudioAdapter;

  constructor(
    private readonly config: OpenAIQuicksilverBridgeConfig,
    private readonly runtime: OpenAIRealtimeHost,
  ) {
    this.audio = new OpenAIQuicksilverAudioAdapter(config);
    this.pendingRawAudio = new QuicksilverSocketAudioQueue(
      config.audioFormat?.encoding === "g711_ulaw" ? 40_000 : 240_000,
    );
  }

  setAudioOutputPort(output: RealtimeVoiceAudioOutputPort): void {
    assertOpenAIQuicksilverPcmOutput(this.config.audioFormat);
    if (this.connectPromise || this.closed) {
      throw new Error("GPT-Live audio output must be configured before connecting");
    }
    this.closeAudioOutput();
    this.audioOutput = output;
  }

  private closeAudioOutput(): void {
    if (!this.audioOutput) {
      return;
    }
    Atomics.store(new Int32Array(this.audioOutput.state), 0, 1);
    this.audioOutput.port.close();
    this.audioOutput = undefined;
  }

  connect(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("GPT-Live gateway relay bridge is closed"));
    }
    this.connectPromise ??= this.connectInternal().catch((error: unknown) => {
      this.closeAudioOutput();
      throw error;
    });
    return this.connectPromise;
  }

  sendAudio(audio: Buffer): void {
    if (this.closed) {
      return;
    }
    if (this.directSocket) {
      this.directSocket.sendAudio(audio);
    } else if (this.transport === "webrtc") {
      const pcm = this.audio.decodeInput(audio);
      if (this.peer) {
        this.peer.sendAudio(pcm);
      } else {
        this.pendingAudio.append(pcm);
      }
    } else if (!this.abortController.signal.aborted) {
      // Auth chooses the transport later. Keep capture raw so the direct worker
      // owns telephony conversion even for audio captured before admission.
      this.pendingRawAudio.append(audio);
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
      const requestIds = createOpenAIQuicksilverRequestIds();
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
      onSessionStarted: resolveReady,
    });
    await this.connectSocket(
      auth,
      requestIds,
      buildOpenAIQuicksilverWebSocketUrl(this.config.model),
      connectSignal,
    );
    if (!this.closed && this.audioOutput) {
      this.directSocket?.setAudioOutputPort(this.audioOutput);
    }
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
    this.pendingAudio.append(this.audio.decodeInput(this.pendingRawAudio.take()));
    this.delegations = this.createDelegationController();
    const createPeer =
      this.config.createPeer ??
      (async (callbacks: OpenAIQuicksilverAudioPeerCallbacks, signal: AbortSignal) => {
        const { OpenAIQuicksilverAudioPeer } =
          await import("./realtime-quicksilver-peer.runtime.js");
        return await OpenAIQuicksilverAudioPeer.create({
          callbacks,
          signal,
          output: this.audioOutput,
        });
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
    await this.connectSocket(auth, requestIds, call.sidebandUrl, connectSignal);
  }

  private async connectSocket(
    auth: OpenAIQuicksilverAuth,
    requestIds: OpenAIQuicksilverRequestIds,
    url: string,
    connectSignal: AbortSignal,
  ): Promise<void> {
    const mediaSocketFactory =
      this.transport === "direct"
        ? (this.config.mediaSocketFactory ??
          (await loadOpenAIQuicksilverMediaSocketFactory(connectSignal)))
        : undefined;
    let directSocket: QuicksilverMediaSocket | undefined;
    const createSocket: OpenAIQuicksilverSocketFactory = mediaSocketFactory
      ? (socketUrl, options) => {
          const socket = mediaSocketFactory(
            socketUrl,
            options,
            {
              model: this.config.model,
              paced: true,
              audioFormat: this.config.audioFormat,
            },
            {
              onAudio: (audio) => {
                if (this.closed) {
                  return;
                }
                this.config.onAudio(audio);
                this.config.onEvent?.({
                  direction: "server",
                  type: isOpenAIGptLiveApiModel(this.config.model)
                    ? "session.output_audio.delta"
                    : "output_audio.delta",
                });
              },
            },
          );
          directSocket = socket;
          return socket;
        }
      : (this.config.webSocketFactory ??
        ((socketUrl, options) => new WebSocket(socketUrl, options)));
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
    this.sideband = connected.socket;
    this.attachSidebandHandlers(connected.socket);
    this.adoptConnectedSocket(connected, directSocket);
  }

  private adoptConnectedSocket(
    connected: Awaited<ReturnType<typeof connectOpenAIQuicksilverSideband>>,
    directSocket: QuicksilverMediaSocket | undefined,
  ): void {
    const terminalEvent = connected.detachBuffer();
    if (!terminalEvent && directSocket) {
      // Failed candidates never own capture. Transfer the bounded opening/backoff
      // tail once, before replaying a buffered session.started can start the clock.
      this.directSocket = directSocket;
      directSocket.sendAudio(this.pendingRawAudio.take());
    }
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
    onSessionStarted?: () => void;
  }): OpenAIQuicksilverDelegationController {
    const runAgentConsult = this.config.runAgentConsult;
    if (!runAgentConsult) {
      throw new Error("OpenAI GPT-Live gateway relay requires the Gateway agent-consult runtime");
    }
    return new OpenAIQuicksilverDelegationController(
      {
        getSocket: () => this.sideband,
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
              this.directSocket?.startAudio();
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
            // Retire the worker backlog even when the consumer uses callbacks.
            if (this.transport === "webrtc") {
              this.peer?.clearOutputAudio?.();
            }
            if (!this.audioOutput) {
              this.config.onClearAudio("barge-in");
            }
          }
        },
        runAgentConsult,
        signal: this.abortController.signal,
      },
      this.runtime.formatErrorMessage,
    );
  }

  private sendSocketEvent(event: object): void {
    const socket = this.sideband;
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
    this.closeAudioOutput();
    this.directSocket?.stopAudio();
    this.closeReason = reason;
    const socket = this.sideband;
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
    this.closeAudioOutput();
    this.directSocket?.stopAudio();
    releaseOpenAIQuicksilverSession(this);
    this.connected = false;
    this.ready = false;
    this.transport = undefined;
    this.pendingAudio.clear();
    this.pendingRawAudio.clear();
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
    const socket = this.sideband;
    this.sideband = undefined;
    this.directSocket = undefined;
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
