import { PassThrough, type Readable } from "node:stream";
import type { DiscordGatewayAdapterLibraryMethods, VoiceConnection } from "@discordjs/voice";
import {
  serializeDiscordAudioError,
  type DiscordAudioCommand,
  type DiscordAudioEvent,
  type DiscordAudioWorkerOptions,
} from "./audio-worker-protocol.js";
import { createDiscordOpusPlaybackStream, decodeOpusStreamChunks } from "./audio.js";
import { DiscordContinuousOutput } from "./continuous-output.runtime.js";
import { DiscordRealtimeOutput } from "./realtime-output.runtime.js";
import {
  DiscordRealtimePlayer,
  DISCORD_REALTIME_PLAYBACK_IDLE_MS,
} from "./realtime-player.runtime.js";
import {
  analyzeVoiceReceiveError,
  enableDaveReceivePassthrough,
  recoverDaveZeroTransition,
  DAVE_RECEIVE_PASSTHROUGH_REARM_EXPIRY_SECONDS,
} from "./receive-recovery.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";

const PLAYBACK_READY_TIMEOUT_MS = 60_000;
const MAX_CAPTURE_PACKETS = 1_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;
type Capture = {
  userId: string;
  stream: Readable;
  pendingPackets: number;
  pendingBytes: number;
  closed: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

/** Owns every Discord socket, codec, resource and packet deadline in one isolate. */
export class DiscordAudioWorker {
  private readonly sdk = loadDiscordVoiceSdk();
  private connection?: VoiceConnection;
  private adapter?: DiscordGatewayAdapterLibraryMethods;
  private readonly player;
  private readonly roomPlayer: DiscordRealtimePlayer;
  private readonly captures = new Map<number, Capture>();
  private readonly outputs = new Map<number, DiscordRealtimeOutput>();
  private readonly continuous = new Map<number, DiscordContinuousOutput>();
  private fileInput?: { id: number; stream: PassThrough };
  private fileAbort?: AbortController;
  private stopped = false;
  private readonly stopAbort = new AbortController();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly onError = (error: unknown) =>
    this.post({ type: "error", error: serializeDiscordAudioError(error) });
  private readonly onDisconnected = () => {
    if (!this.stopped && this.connection) {
      void this.recoverConnection(this.connection);
    }
  };
  private readonly onDestroyed = () => {
    void this.stop();
  };

  constructor(
    private readonly options: DiscordAudioWorkerOptions,
    private readonly post: (event: DiscordAudioEvent) => void,
  ) {
    this.player = options.realtime
      ? this.sdk.createAudioPlayer({
          behaviors: { maxMissedFrames: DISCORD_REALTIME_PLAYBACK_IDLE_MS / 20 },
        })
      : this.sdk.createAudioPlayer();
    this.roomPlayer = new DiscordRealtimePlayer(this.player);
    this.player.on("stateChange", (_old, state) =>
      this.post({ type: "player", status: state.status }),
    );
    this.player.on("error", this.onError);
  }

  async connect(): Promise<void> {
    const deadline = Date.now() + this.options.connectTimeoutMs;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.stopped) {
        return;
      }
      const connection = this.sdk.joinVoiceChannel({
        guildId: this.options.guildId,
        channelId: this.options.channelId,
        group: this.options.group,
        selfDeaf: this.options.selfDeaf,
        selfMute: this.options.selfMute,
        daveEncryption: this.options.daveEncryption,
        decryptionFailureTolerance: this.options.decryptionFailureTolerance,
        adapterCreator: (methods) => {
          this.adapter = methods;
          return {
            sendPayload: (payload) => {
              // Acceptance queues signalling only. A definite main-gateway send
              // failure returns through gateway-failed and destroys this attempt.
              this.post({ type: "gateway-send", payload });
              return true;
            },
            destroy: () => {},
          };
        },
      });
      this.connection = connection;
      connection.on("error", this.onError);
      try {
        await this.sdk.entersState(
          connection,
          this.sdk.VoiceConnectionStatus.Ready,
          AbortSignal.any([
            this.stopAbort.signal,
            AbortSignal.timeout(Math.max(1, deadline - Date.now())),
          ]),
        );
        if (this.stopped) {
          return;
        }
        connection.subscribe(this.player);
        connection.on("stateChange", (_old, state) => {
          this.post({ type: "connection", status: state.status });
        });
        connection.on(this.sdk.VoiceConnectionStatus.Destroyed, this.onDestroyed);
        connection.on(this.sdk.VoiceConnectionStatus.Disconnected, this.onDisconnected);
        connection.receiver.speaking.on("start", this.onSpeakingStart);
        connection.receiver.speaking.on("end", this.onSpeakingEnd);
        for (const userId of connection.receiver.speaking.users.keys()) {
          this.post({ type: "speaking", userId, speaking: true });
        }
        this.post({ type: "connection", status: connection.state.status });
        this.post({ type: "ready" });
        return;
      } catch (error) {
        if (this.stopped) {
          return;
        }
        if (connection.state.status !== this.sdk.VoiceConnectionStatus.Destroyed) {
          connection.destroy();
        }
        if (
          attempt === 0 &&
          !this.stopped &&
          Date.now() < deadline &&
          error instanceof Error &&
          error.message.toLowerCase().includes("operation was aborted")
        ) {
          continue;
        }
        throw error;
      }
    }
  }

  receive(command: DiscordAudioCommand): void {
    if (this.stopped) {
      return;
    }
    switch (command.type) {
      case "gateway-server":
        this.adapter?.onVoiceServerUpdate(command.data);
        break;
      case "gateway-state":
        this.adapter?.onVoiceStateUpdate(command.data);
        break;
      case "gateway-failed":
        this.post({
          type: "error",
          error: {
            name: "Error",
            message: "Discord main gateway could not send voice signalling.",
          },
        });
        this.adapter?.destroy();
        void this.stop();
        break;
      case "stop":
        void this.stop();
        break;
      case "continuous-port": {
        const lane = new DiscordContinuousOutput({
          id: command.id,
          enabled: command.enabled,
          port: command.port,
          state: new Int32Array(command.state),
          clock: new BigInt64Array(command.clock),
          player: this.roomPlayer,
          post: this.post,
          logContext: "guild=" + this.options.guildId + " channel=" + this.options.channelId,
        });
        this.continuous.set(command.id, lane);
        command.port.once("close", () => this.continuous.delete(command.id));
        break;
      }
      case "continuous-activate":
        this.continuous.get(command.id)?.activate();
        break;
      case "continuous-clear":
        this.continuous.get(command.id)?.clear();
        break;
      case "continuous-flush":
        this.continuous.get(command.id)?.flush(command.marker);
        break;
      case "continuous-close":
        this.continuous.get(command.id)?.close();
        this.continuous.delete(command.id);
        break;
      case "capture":
        this.track(this.capture(command.id, command.userId, command.recordingEpoch));
        break;
      case "capture-stop": {
        const capture = this.captures.get(command.id);
        if (capture) {
          this.stopCapture(capture);
        }
        break;
      }
      case "capture-ack": {
        const capture = this.captures.get(command.id);
        if (capture) {
          capture.pendingPackets = Math.max(0, capture.pendingPackets - 1);
          capture.pendingBytes = Math.max(0, capture.pendingBytes - command.bytes);
        }
        break;
      }
      case "passthrough":
        this.enablePassthrough(command.reason, command.expirySeconds);
        break;
      case "output-create": {
        const output = new DiscordRealtimeOutput({
          player: this.roomPlayer,
          clock: new BigInt64Array(command.clock),
          logContext: "guild=" + this.options.guildId + " channel=" + this.options.channelId,
          continuous: command.continuous,
          onStart: () => this.post({ type: "output-start", id: command.id }),
          onClose: (_output, reason) => {
            this.outputs.delete(command.id);
            // Natural retirement can acknowledge its last consumed marks after
            // onClose. Deliver those before retiring their parent callbacks.
            queueMicrotask(() => this.post({ type: "output-close", id: command.id, reason }));
          },
          onError: (error) =>
            this.post({
              type: "output-error",
              id: command.id,
              error: serializeDiscordAudioError(error),
            }),
        });
        this.outputs.set(command.id, output);
        break;
      }
      case "output-audio":
        this.outputs.get(command.id)?.appendAdmitted(Buffer.from(command.audio), command.audible);
        break;
      case "output-mark":
        this.outputs
          .get(command.id)
          ?.markPlayback(() =>
            this.post({ type: "output-mark", id: command.id, markId: command.markId }),
          );
        break;
      case "output-finish":
        this.outputs.get(command.id)?.finish(command.reason, command.playBuffered);
        break;
      case "output-close":
        this.outputs.get(command.id)?.close(command.reason);
        break;
      case "output-hold":
        this.roomPlayer.hold(command.hold);
        break;
      case "output-shutdown":
        this.retireOutputs();
        break;
      case "player-stop":
        this.fileAbort?.abort();
        this.player.stop(true);
        break;
      case "file-play":
        this.track(this.playFile(command.id, command.path));
        break;
      case "stream-play": {
        const stream = new PassThrough();
        this.fileInput = { id: command.id, stream };
        this.track(this.playFile(command.id, stream));
        break;
      }
      case "stream-chunk": {
        if (this.fileInput?.id !== command.id) {
          break;
        }
        const writable = this.fileInput.stream.write(Buffer.from(command.audio));
        if (writable) {
          this.post({ type: "stream-drain", id: command.id });
        } else {
          this.fileInput.stream.once("drain", () =>
            this.post({ type: "stream-drain", id: command.id }),
          );
        }
        break;
      }
      case "stream-end":
        if (this.fileInput?.id === command.id) {
          this.fileInput.stream.end();
        }
        break;
    }
  }

  private retireOutputs(): void {
    // A failed realtime promotion retains its recording transport. Retire this
    // generation atomically without permanently closing the reusable room player.
    this.roomPlayer.transition(() => {
      for (const lane of this.continuous.values()) {
        lane.close();
      }
      this.continuous.clear();
      // Close only this generation; close callbacks retire entries from the map.
      const retiring = [...this.outputs.values()];
      for (const output of retiring) {
        output.close("session-close");
      }
    });
  }

  private async recoverConnection(connection: VoiceConnection): Promise<void> {
    const recovery = new AbortController();
    const signal = AbortSignal.any([
      this.stopAbort.signal,
      recovery.signal,
      AbortSignal.timeout(this.options.reconnectGraceMs),
    ]);
    try {
      await Promise.race([
        this.sdk.entersState(connection, this.sdk.VoiceConnectionStatus.Signalling, signal),
        this.sdk.entersState(connection, this.sdk.VoiceConnectionStatus.Connecting, signal),
      ]);
    } catch (error) {
      if (!this.stopped) {
        this.post({ type: "error", error: serializeDiscordAudioError(error) });
        await this.stop();
      }
    } finally {
      recovery.abort();
    }
  }

  private enablePassthrough(reason: string, expirySeconds: number): void {
    if (!this.connection) {
      return;
    }
    enableDaveReceivePassthrough({
      target: {
        guildId: this.options.guildId,
        channelId: this.options.channelId,
        connection: this.connection,
      },
      sdk: this.sdk,
      reason,
      expirySeconds,
      onVerbose: (message) => this.post({ type: "log", level: "verbose", message }),
      onWarn: (message) => this.post({ type: "log", level: "warn", message }),
    });
  }

  private readonly onSpeakingStart = (userId: string) => {
    if (this.stopped) {
      return;
    }
    for (const capture of this.captures.values()) {
      if (capture.userId === userId) {
        clearTimeout(capture.timer);
        capture.timer = undefined;
      }
    }
    this.post({ type: "speaking", userId, speaking: true });
  };
  private readonly onSpeakingEnd = (userId: string) => {
    if (this.stopped) {
      return;
    }
    for (const [id, capture] of this.captures) {
      if (capture.userId === userId) {
        this.finalizeLater(id, capture);
      }
    }
    this.post({ type: "speaking", userId, speaking: false });
  };
  private stopCapture(capture: Capture): void {
    if (capture.closed) {
      return;
    }
    capture.closed = true;
    clearTimeout(capture.timer);
    if (!capture.stream.destroyed) {
      capture.stream.destroy();
    }
  }

  private finalizeLater(id: number, capture: Capture): void {
    clearTimeout(capture.timer);
    capture.timer = setTimeout(() => {
      if (this.captures.get(id) === capture) {
        this.stopCapture(capture);
      }
    }, this.options.captureSilenceGraceMs);
  }

  private async capture(
    id: number,
    userId: string,
    recordingEpoch: SharedArrayBuffer,
  ): Promise<void> {
    const connection = this.connection;
    if (!connection || this.captures.has(id)) {
      return;
    }
    // Only an admitted parent command can create a receiver subscription.
    const stream = connection.receiver.subscribe(userId, {
      end: { behavior: this.sdk.EndBehaviorType.Manual },
    });
    const capture: Capture = { userId, stream, pendingPackets: 0, pendingBytes: 0, closed: false };
    this.captures.set(id, capture);
    const input = new PassThrough({ objectMode: true });
    const recordingClock = new BigInt64Array(recordingEpoch);
    const receipts = new WeakMap<Buffer, { receivedAt: number; recordingEpoch: bigint }>();
    let failed = false;
    let abortReported = false;
    let decodedFrames = 0;
    const onError = (error: unknown) => {
      if (failed) {
        return;
      }
      const analysis = analyzeVoiceReceiveError(error);
      if (analysis.isAbortLike && !analysis.countsAsDecryptFailure) {
        if (!abortReported) {
          this.post({ type: "capture-error", id, error: serializeDiscordAudioError(error) });
        }
        abortReported = true;
        return;
      }
      failed = true;
      let recovery: "not-attempted" | "recovered" | "failed" = "not-attempted";
      if (analysis.shouldAttemptPassthrough) {
        recovery = recoverDaveZeroTransition({
          target: { guildId: this.options.guildId, channelId: this.options.channelId, connection },
          sdk: this.sdk,
          onWarn: (message) => this.post({ type: "log", level: "warn", message }),
        });
        if (recovery !== "failed") {
          this.enablePassthrough(
            "receive decrypt error",
            DAVE_RECEIVE_PASSTHROUGH_REARM_EXPIRY_SECONDS,
          );
        }
      }
      this.post({
        type: "capture-error",
        id,
        error: {
          ...serializeDiscordAudioError(error),
          ...(recovery === "failed" ? { daveRecoveryFailed: true } : {}),
        },
      });
    };
    const accept = (packet: Buffer) => {
      if (failed || capture.closed || !packet.length) {
        return;
      }
      if (
        capture.pendingPackets >= MAX_CAPTURE_PACKETS ||
        capture.pendingBytes + packet.length > MAX_CAPTURE_BYTES
      ) {
        onError(new Error("Discord voice receive backlog exceeded; try speaking again."));
        this.stopCapture(capture);
        input.destroy();
        return;
      }
      capture.pendingPackets += 1;
      capture.pendingBytes += packet.length;
      const owned = Buffer.from(packet);
      receipts.set(owned, {
        receivedAt: Date.now(),
        recordingEpoch: Atomics.load(recordingClock, 0),
      });
      input.write(owned);
    };
    const end = () => input.end();
    const finalized = () => {
      clearTimeout(capture.timer);
      capture.closed = true;
      // SDK subscription cleanup registered first; only now can the same user
      // subscribe again, independently of the old decoder or recorder frontier.
      this.post({ type: "capture-finalized", id });
      input.end();
    };
    stream.on("data", accept);
    stream.on("end", end);
    stream.once("close", finalized);
    stream.on("error", onError);
    if (!connection.receiver.speaking.users.has(userId)) {
      this.finalizeLater(id, capture);
    }
    try {
      await decodeOpusStreamChunks(input, {
        onChunk: async (pcm, packet) => {
          const receipt = receipts.get(packet);
          if (!failed && receipt) {
            this.post({
              type: "capture-frame",
              id,
              frame: { pcm, packet, ...receipt },
            });
          }
          // A socket backlog must yield to the SDK packet clock, not drain in an
          // unbroken microtask chain after decoding catches up.
          if (++decodedFrames % 8 === 0) {
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
          }
        },
        onError,
        onVerbose: (message) => this.post({ type: "log", level: "verbose", message }),
        onWarn: (message) => this.post({ type: "log", level: "warn", message }),
      });
    } finally {
      clearTimeout(capture.timer);
      this.captures.delete(id);
      stream.off("data", accept);
      stream.off("end", end);
      stream.off("error", onError);
      this.stopCapture(capture);
      input.destroy();
      this.post({ type: "capture-end", id });
    }
  }

  private async playFile(id: number, input: string | Readable): Promise<void> {
    const abort = new AbortController();
    this.fileAbort?.abort();
    this.fileAbort = abort;
    let error: ReturnType<typeof serializeDiscordAudioError> | undefined;
    const onError = (cause: Error) => {
      error = serializeDiscordAudioError(cause);
      abort.abort();
    };
    let playbackStarted = false;
    const onIdle = () => {
      if (!playbackStarted) {
        abort.abort();
      }
    };
    this.player.on("error", onError);
    this.player.on(this.sdk.AudioPlayerStatus.Idle, onIdle);
    try {
      this.player.play(
        this.sdk.createAudioResource(createDiscordOpusPlaybackStream(input), {
          inputType: this.sdk.StreamType.Opus,
        }),
      );
      await this.sdk.entersState(
        this.player,
        this.sdk.AudioPlayerStatus.Playing,
        AbortSignal.any([AbortSignal.timeout(PLAYBACK_READY_TIMEOUT_MS), abort.signal]),
      );
      playbackStarted = true;
      await this.sdk.entersState(this.player, this.sdk.AudioPlayerStatus.Idle, abort.signal);
    } catch (cause) {
      error ??= serializeDiscordAudioError(cause);
    } finally {
      this.player.off("error", onError);
      this.player.off(this.sdk.AudioPlayerStatus.Idle, onIdle);
      if (this.fileAbort === abort) {
        this.fileAbort = undefined;
      }
      if (this.fileInput?.id === id) {
        this.fileInput.stream.destroy();
        this.fileInput = undefined;
      }
      this.post({ type: "file-end", id, ...(error ? { error } : {}) });
    }
  }

  private track(task: Promise<unknown>): void {
    this.tasks.add(task);
    void task.catch(this.onError).finally(() => this.tasks.delete(task));
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.stopAbort.abort();
    this.post({ type: "connection", status: this.sdk.VoiceConnectionStatus.Destroyed });
    this.retireOutputs();
    this.roomPlayer.close();
    this.fileAbort?.abort();
    this.fileInput?.stream.destroy();
    for (const capture of this.captures.values()) {
      this.stopCapture(capture);
    }
    const connection = this.connection;
    connection?.receiver.speaking.off("start", this.onSpeakingStart);
    connection?.receiver.speaking.off("end", this.onSpeakingEnd);
    // Retire recovery callbacks before destroy emits terminal connection events.
    connection?.off(this.sdk.VoiceConnectionStatus.Disconnected, this.onDisconnected);
    connection?.off(this.sdk.VoiceConnectionStatus.Destroyed, this.onDestroyed);
    this.player.off("error", this.onError);
    if (connection && connection.state.status !== this.sdk.VoiceConnectionStatus.Destroyed) {
      connection.destroy();
    }
    this.post({ type: "gateway-destroy" });
    // Capture decoders release their WASM handles before the runtime closes its port.
    await Promise.allSettled(this.tasks);
    this.post({ type: "stopped" });
  }
}
