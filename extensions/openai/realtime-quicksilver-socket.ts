import { EventEmitter } from "node:events";
import { Worker, type MessagePort } from "node:worker_threads";
import {
  resolveRuntimeWorkerUrl,
  resolveRuntimeWorkerArgv,
} from "openclaw/plugin-sdk/process-runtime";
import type { RealtimeVoiceAudioOutputPort } from "openclaw/plugin-sdk/realtime-voice";
import {
  QUICKSILVER_SOCKET_AUDIO_BATCH_BYTES,
  QUICKSILVER_SOCKET_CONTROL_BYTES,
  QUICKSILVER_SOCKET_CONTROL_LIMIT,
  QuicksilverSocketAudioQueue,
  type QuicksilverMediaSocket,
  type QuicksilverMediaSocketFactory,
  type QuicksilverSocketCallbacks,
  type QuicksilverSocketCommand,
  type QuicksilverSocketMessage,
} from "./realtime-quicksilver-socket.shared.js";

/** A local socket-shaped control adapter, not a second media transport. */
export class OpenAIQuicksilverWorkerSocket extends EventEmitter implements QuicksilverMediaSocket {
  static create(
    this: void,
    url: string,
    options: Parameters<QuicksilverMediaSocketFactory>[1],
    media: Parameters<QuicksilverMediaSocketFactory>[2],
    callbacks: QuicksilverSocketCallbacks,
  ): OpenAIQuicksilverWorkerSocket {
    const workerUrl = resolveRuntimeWorkerUrl({
      currentModuleUrl: import.meta.url,
      sourceWorkerName: "realtime-quicksilver-socket.worker",
      distWorkerPath: "extensions/openai/realtime-quicksilver-socket.worker.js",
      package: {
        name: "@openclaw/openai-provider",
        distWorkerPath: "realtime-quicksilver-socket.worker.js",
      },
    });
    const worker = new Worker(workerUrl, {
      workerData: {
        url,
        options: { headers: options.headers, maxPayload: options.maxPayload },
        ...media,
      },
      execArgv: resolveRuntimeWorkerArgv(workerUrl).slice(0, -1),
    });
    return new OpenAIQuicksilverWorkerSocket(
      worker,
      callbacks,
      media.audioFormat?.encoding === "g711_ulaw",
    );
  }

  readyState = 0;
  private mediaStopped = false;
  private audioOutputState: Int32Array | undefined;
  private started = false;
  private inputInFlight = false;
  private sendInFlight = false;
  private failed = false;
  private exited = false;
  private readonly pending: QuicksilverSocketAudioQueue;
  private readonly sends: string[] = [];
  private sendBytes = 0;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private closing: { code: number; reason: string } | undefined;
  private closePosted = false;

  private constructor(
    private readonly worker: Worker,
    private readonly callbacks: QuicksilverSocketCallbacks,
    private readonly telephony: boolean,
  ) {
    super();
    this.pending = new QuicksilverSocketAudioQueue(telephony ? 40_000 : 240_000);
    worker.on("message", (message: QuicksilverSocketMessage) => this.receive(message));
    worker.on("error", () => {
      if (!this.closePosted) {
        this.fail();
      }
    });
    worker.on("exit", () => {
      this.exited = true;
      if (this.closeTimer) {
        clearTimeout(this.closeTimer);
      }
      if (this.readyState !== 3) {
        if (this.readyState !== 2 || !this.closePosted) {
          this.fail();
        }
        this.finishClose(1006, "media worker exited");
      }
    });
  }

  send(payload: string): void {
    if (this.readyState !== 1) {
      return;
    }
    const bytes = Buffer.byteLength(payload);
    if (
      this.sends.length >= QUICKSILVER_SOCKET_CONTROL_LIMIT ||
      this.sendBytes + bytes > QUICKSILVER_SOCKET_CONTROL_BYTES
    ) {
      this.fail();
      return;
    }
    this.sends.push(payload);
    this.sendBytes += bytes;
    this.flushSends();
  }

  sendAudio(audio: Buffer): void {
    if (this.mediaStopped || this.readyState >= 2) {
      return;
    }
    this.pending.append(audio);
    this.flushInput();
  }

  setAudioOutputPort(output: RealtimeVoiceAudioOutputPort): void {
    if (this.audioOutputState) {
      throw new Error("GPT-Live audio output is already bound");
    }
    if (this.mediaStopped || this.readyState !== 1) {
      Atomics.store(new Int32Array(output.state), 0, 1);
      output.port.close();
      return;
    }
    this.audioOutputState = new Int32Array(output.state);
    this.post({ type: "audio-output", output }, [output.port]);
  }

  startAudio(): void {
    if (this.mediaStopped || this.started || this.readyState !== 1) {
      return;
    }
    this.started = true;
    this.post({ type: "start-audio" });
  }

  stopAudio(): void {
    if (this.mediaStopped) {
      return;
    }
    this.mediaStopped = true;
    if (this.audioOutputState) {
      Atomics.store(this.audioOutputState, 0, 1);
    }
    this.pending.clear();
    this.post({ type: "stop-audio" });
  }

  close(code = 1000, reason = "session closed"): void {
    if (this.readyState >= 2) {
      return;
    }
    this.stopAudio();
    this.readyState = 2;
    this.closing = { code, reason };
    this.scheduleCloseDeadline();
    // Stop admission now, but preserve the bounded FIFO already accepted by
    // send(). The worker's send acknowledgement precedes transport close.
    this.flushSends();
  }

  private scheduleCloseDeadline(): void {
    if (this.closeTimer || this.exited) {
      return;
    }
    this.closeTimer = setTimeout(() => {
      void this.worker.terminate();
    }, 2_000);
    this.closeTimer.unref();
  }

  private closeTransport(): void {
    if (!this.closing || this.closePosted) {
      return;
    }
    this.closePosted = true;
    this.post({ type: "close", ...this.closing });
  }

  private post(command: QuicksilverSocketCommand, transfer: MessagePort[] = []): void {
    if (this.exited) {
      return;
    }
    // Node Worker has no browser targetOrigin. Audio has a single credited batch.
    this.worker.postMessage(command, transfer);
  }

  private flushInput(): void {
    if (this.inputInFlight || this.mediaStopped || !this.pending.length || this.readyState !== 1) {
      return;
    }
    this.inputInFlight = true;
    this.post({
      type: "audio",
      audio: this.pending.take(this.telephony ? 1_600 : QUICKSILVER_SOCKET_AUDIO_BATCH_BYTES),
    });
  }

  private flushSends(): void {
    if (this.sendInFlight || this.readyState === 0 || this.readyState === 3 || this.closePosted) {
      return;
    }
    const payload = this.sends.shift();
    if (payload === undefined) {
      this.closeTransport();
      return;
    }
    this.sendBytes -= Buffer.byteLength(payload);
    this.sendInFlight = true;
    this.post({ type: "send", payload });
  }

  private receive(message: QuicksilverSocketMessage): void {
    if (message.type === "input-ack") {
      this.inputInFlight = false;
      this.flushInput();
      return;
    }
    if (message.type === "send-ack") {
      this.sendInFlight = false;
      this.flushSends();
      return;
    }
    try {
      if (message.type === "close") {
        this.finishClose(message.code, message.reason);
        return;
      }
      if (message.type === "error") {
        if (!this.closePosted) {
          this.fail();
        }
        return;
      }
      if (this.readyState >= 2) {
        return;
      }
      switch (message.type) {
        case "open":
          this.readyState = 1;
          this.flushInput();
          this.emit("open");
          break;
        case "frame":
          this.emit(
            "message",
            Buffer.from(message.data.buffer, message.data.byteOffset, message.data.byteLength),
            message.isBinary,
          );
          break;
        case "audio":
          if (!this.mediaStopped && !this.audioOutputState) {
            this.callbacks.onAudio(
              Buffer.from(message.audio.buffer, message.audio.byteOffset, message.audio.byteLength),
            );
          }
          break;
      }
    } finally {
      this.post({ type: "event-ack" });
    }
  }

  private finishClose(code: number, reason: string): void {
    if (this.readyState === 3) {
      return;
    }
    this.mediaStopped = true;
    if (this.audioOutputState) {
      Atomics.store(this.audioOutputState, 0, 1);
    }
    this.pending.clear();
    this.sends.length = 0;
    this.sendBytes = 0;
    this.readyState = 3;
    this.closing = undefined;
    this.emit("close", code, Buffer.from(reason));
  }

  private fail(): void {
    if (this.failed || this.readyState === 3) {
      return;
    }
    this.failed = true;
    try {
      this.emit("error", new Error("GPT-Live media worker transport failed"));
    } finally {
      // A transport failure cannot acknowledge the pending FIFO. Abort it
      // rather than waiting for credits that will never arrive.
      this.stopAudio();
      this.readyState = 2;
      this.sends.length = 0;
      this.sendBytes = 0;
      this.closing = { code: 1011, reason: "media transport failed" };
      this.scheduleCloseDeadline();
      this.closeTransport();
    }
  }
}
