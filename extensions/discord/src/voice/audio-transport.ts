import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { MessagePort } from "node:worker_threads";
import type {
  DiscordGatewayAdapterCreator,
  DiscordGatewayAdapterImplementerMethods,
} from "@discordjs/voice";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createSubsystemLogger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  restoreDiscordAudioError,
  type DiscordAudioCommand,
  type DiscordAudioEvent,
  type DiscordAudioFrame,
  type DiscordAudioWorkerOptions,
} from "./audio-worker-protocol.js";
import {
  createDiscordAudioWorkerThread,
  type DiscordAudioWorkerThread,
} from "./audio-worker-thread.js";

const logger = createSubsystemLogger("discord/voice");
const STOP_GRACE_MS = 2_000;

/** A received frame owns cloned PCM; its credit remains held until the consumer settles. */
export class DiscordAudioCapture extends Readable {
  physicalFinalized = false;

  finalizePhysicalSubscription(): void {
    if (this.physicalFinalized) {
      return;
    }
    this.physicalFinalized = true;
    this.emit("finalized");
  }
  constructor(
    readonly id: number,
    private readonly send: (command: DiscordAudioCommand) => void,
  ) {
    super({ objectMode: true });
  }
  override _read(): void {}
  stopInput(): void {
    this.send({ type: "capture-stop", id: this.id });
  }
  acknowledge(frame: DiscordAudioFrame): void {
    this.send({ type: "capture-ack", id: this.id, bytes: frame.packet.byteLength });
  }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.send({ type: "capture-stop", id: this.id });
    done(error);
  }
}

type FilePlayback = {
  resolve: () => void;
  reject: (error: Error) => void;
  drain?: () => void;
  abort: AbortController;
};

/** Control-plane handle, never a substitute SDK connection or audio player. */
export class DiscordAudioTransport extends EventEmitter<{
  event: [event: DiscordAudioEvent];
  stopped: [];
  speaking: [userId: string, speaking: boolean];
}> {
  readonly speakingUsers = new Set<string>();
  playerStatus = "idle";
  connectionStatus = "signalling";
  private readonly worker: DiscordAudioWorkerThread;
  private readonly adapter: DiscordGatewayAdapterImplementerMethods;
  private readonly captures = new Map<number, DiscordAudioCapture>();
  private readonly files = new Map<number, FilePlayback>();
  private nextId = 0;
  private stopping = false;
  private terminal = false;
  private adapterDestroyed = false;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  readonly ready: Promise<void>;
  private readonly exited: Promise<void>;
  private stopTask?: Promise<void>;
  private physicalStopResolve!: () => void;
  private readonly physicalStopped = new Promise<void>((resolve) => {
    this.physicalStopResolve = resolve;
  });

  constructor(options: DiscordAudioWorkerOptions, adapterCreator: DiscordGatewayAdapterCreator) {
    super();
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Preserve rejection for the join caller without an unhandled startup rejection.
    void this.ready.catch(() => {});
    this.worker = createDiscordAudioWorkerThread(options);
    try {
      this.adapter = adapterCreator({
        onVoiceServerUpdate: (data) => this.send({ type: "gateway-server", data }),
        onVoiceStateUpdate: (data) => this.send({ type: "gateway-state", data }),
        destroy: () => {
          void this.stop();
        },
      });
    } catch (error) {
      void this.worker.terminate();
      throw error;
    }
    this.worker.on("message", (event: DiscordAudioEvent) => this.receive(event));
    this.worker.on("error", (error) =>
      this.finish(toErrorObject(error, "Discord audio worker failed")),
    );
    this.exited = new Promise((resolve) => {
      this.worker.once("exit", (code) => {
        this.finish(new Error("Discord audio worker exited (" + code + ")."));
        resolve();
      });
    });
  }

  allocateId(): number {
    return ++this.nextId;
  }

  send(command: DiscordAudioCommand, transferList?: readonly MessagePort[]): void {
    if (this.terminal || (this.stopping && command.type !== "stop")) {
      return;
    }
    try {
      this.worker.postMessage(command, transferList);
    } catch (error) {
      this.finish(error instanceof Error ? error : new Error(String(error)));
    }
  }

  subscribe(userId: string, recordingEpoch: SharedArrayBuffer): DiscordAudioCapture {
    if (this.stopping || this.terminal) {
      throw new Error("Discord voice session stopped before capture.");
    }
    const id = this.allocateId();
    const capture = new DiscordAudioCapture(id, (command) => this.send(command));
    this.captures.set(id, capture);
    capture.once("close", () => {
      // Decoded EOF may precede the SDK source close. Retain the control
      // projection until finalization can retire a still-processing reservation.
      if (capture.physicalFinalized) {
        this.captures.delete(id);
      }
    });
    this.send({ type: "capture", id, userId, recordingEpoch });
    return capture;
  }

  enablePassthrough(reason: string, expirySeconds: number): void {
    this.send({ type: "passthrough", reason, expirySeconds });
  }

  stopPlayback(): void {
    this.send({ type: "player-stop" });
  }

  async play(input: string | Readable): Promise<void> {
    if (this.stopping || this.terminal) {
      throw new Error("Discord voice session stopped before playback.");
    }
    const id = this.allocateId();
    const abort = new AbortController();
    const complete = new Promise<void>((resolve, reject) => {
      this.files.set(id, { resolve, reject, abort });
    });
    void complete.catch(() => {});
    this.send(
      typeof input === "string"
        ? { type: "file-play", id, path: input }
        : { type: "stream-play", id },
    );
    const pump =
      typeof input === "string"
        ? Promise.resolve()
        : (async () => {
            const destroy = () => input.destroy();
            abort.signal.addEventListener("abort", destroy, { once: true });
            try {
              for await (const chunk of input) {
                if (abort.signal.aborted) {
                  break;
                }
                const frame = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                // One bounded outstanding chunk follows the worker ffmpeg pipe's drain;
                // never enqueue an entire provider stream in MessagePort memory.
                for (
                  let offset = 0;
                  offset < frame.length && !abort.signal.aborted;
                  offset += 64 * 1024
                ) {
                  const playback = this.files.get(id);
                  if (!playback) {
                    return;
                  }
                  const drained = new Promise<void>((resolve) => {
                    playback.drain = resolve;
                  });
                  this.send({
                    type: "stream-chunk",
                    id,
                    audio: frame.subarray(offset, offset + 64 * 1024),
                  });
                  await drained;
                }
              }
              this.send({ type: "stream-end", id });
            } finally {
              abort.signal.removeEventListener("abort", destroy);
            }
          })();
    try {
      await Promise.all([pump, complete]);
    } catch (error) {
      this.stopPlayback();
      throw error;
    } finally {
      abort.abort();
      this.files.get(id)?.drain?.();
      this.files.delete(id);
    }
  }

  stop(): Promise<void> {
    if (this.stopTask) {
      return this.stopTask;
    }
    this.stopping = true;
    this.send({ type: "stop" });
    const drained = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.exited,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              void this.worker.terminate().then(() => resolve());
            }, STOP_GRACE_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        this.finish(new Error("Discord voice session stopped."));
      }
    })();
    // Old decoders may still own admitted recording bytes after sockets close.
    // A replacement must wait for the final gateway leave, not the recorder.
    this.stopTask = Promise.race([this.physicalStopped, drained]);
    return this.stopTask;
  }

  private receive(event: DiscordAudioEvent): void {
    if (this.terminal) {
      return;
    }
    switch (event.type) {
      case "gateway-send":
        if (!this.adapter.sendPayload(event.payload)) {
          this.send({ type: "gateway-failed" });
        }
        break;
      case "gateway-destroy":
        this.destroyAdapter();
        this.physicalStopResolve();
        break;
      case "ready":
        this.readyResolve();
        break;
      case "stopped":
        this.finish(new Error("Discord voice session stopped."), true);
        break;
      case "connection":
        this.connectionStatus = event.status;
        if (event.status === "destroyed") {
          this.emit("stopped");
        }
        break;
      case "player":
        this.playerStatus = event.status;
        break;
      case "speaking":
        if (event.speaking) {
          this.speakingUsers.add(event.userId);
        } else {
          this.speakingUsers.delete(event.userId);
        }
        if (!this.stopping) {
          this.emit("speaking", event.userId, event.speaking);
        }
        break;
      case "capture-frame": {
        const capture = this.captures.get(event.id);
        if (capture && !capture.destroyed) {
          capture.push({
            ...event.frame,
            pcm: Buffer.from(event.frame.pcm),
            packet: Buffer.from(event.frame.packet),
          });
        }
        break;
      }
      case "capture-error":
        this.captures.get(event.id)?.emit("error", restoreDiscordAudioError(event.error));
        break;
      case "capture-finalized": {
        const capture = this.captures.get(event.id);
        capture?.finalizePhysicalSubscription();
        if (capture?.destroyed) {
          this.captures.delete(event.id);
        }
        break;
      }
      case "capture-end":
        this.captures.get(event.id)?.push(null);
        break;
      case "file-end": {
        const playback = this.files.get(event.id);
        this.files.delete(event.id);
        playback?.abort.abort();
        playback?.drain?.();
        if (event.error) {
          playback?.reject(restoreDiscordAudioError(event.error));
        } else {
          playback?.resolve();
        }
        break;
      }
      case "stream-drain": {
        const playback = this.files.get(event.id);
        playback?.drain?.();
        if (playback) {
          playback.drain = undefined;
        }
        break;
      }
      case "error":
        this.readyReject(restoreDiscordAudioError(event.error));
        logger.warn("discord voice: " + event.error.message);
        break;
      case "log":
        if (event.level === "warn") {
          logger.warn(event.message);
        } else {
          logVerbose(event.message);
        }
        break;
      case "continuous-start":
      case "continuous-idle":
      case "continuous-flushed":
      case "continuous-error":
      case "output-start":
      case "output-close":
      case "output-mark":
      case "output-error":
        // Individual playback lanes consume these events below.
        break;
    }
    if (!this.stopping) {
      this.emit("event", event);
    }
  }

  private destroyAdapter(): void {
    if (this.adapterDestroyed) {
      return;
    }
    this.adapterDestroyed = true;
    this.adapter.destroy();
  }

  private finish(error: Error, drained = false): void {
    if (this.terminal) {
      return;
    }
    this.terminal = true;
    this.connectionStatus = "destroyed";
    this.playerStatus = "idle";
    this.readyReject(error);
    this.destroyAdapter();
    this.speakingUsers.clear();
    for (const capture of this.captures.values()) {
      // Graceful worker exit follows every decoded frame. Do not turn its EOF
      // into an error while the parent still records the accepted final bytes.
      if (drained) {
        capture.push(null);
      } else {
        capture.destroy(error);
      }
    }
    this.captures.clear();
    for (const playback of this.files.values()) {
      playback.abort.abort();
      playback.drain?.();
      playback.reject(error);
    }
    this.files.clear();
    this.emit("stopped");
  }
}

export function createDiscordAudioTransport(
  options: DiscordAudioWorkerOptions,
  adapterCreator: DiscordGatewayAdapterCreator,
): DiscordAudioTransport {
  return new DiscordAudioTransport(options, adapterCreator);
}
