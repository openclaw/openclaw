// Control-plane facade; codecs, WebRTC sockets and packet clocks live in the worker.
import { Worker } from "node:worker_threads";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import type { RealtimeVoiceAudioOutputPort } from "openclaw/plugin-sdk/realtime-voice-provider";
import { OpenAIQuicksilverPendingAudio } from "./realtime-quicksilver-audio-buffer.js";
import type {
  OpenAIQuicksilverAudioPeerCallbacks,
  OpenAIQuicksilverAudioPeerContract,
} from "./realtime-quicksilver-media.runtime.js";

export type {
  OpenAIQuicksilverAudioPeerCallbacks,
  OpenAIQuicksilverAudioPeerContract,
} from "./realtime-quicksilver-media.runtime.js";

export type QuicksilverAudioWorkerCommand =
  | { type: "offer"; id: number }
  | { type: "answer"; id: number; sdp: string }
  | { type: "audio"; audio: Uint8Array }
  | { type: "audio-ack" }
  | { type: "clear-output"; generation: number }
  | { type: "rtp-ack" }
  | { type: "media-error-ack" }
  | { type: "close" };

export type QuicksilverAudioWorkerEvent =
  | { type: "ready" }
  | { type: "result"; id: number; value: string }
  | { type: "request-error"; id: number; message: string }
  | { type: "audio"; audio: Uint8Array; generation: number }
  | { type: "input-ack" }
  | { type: "rtp" }
  | { type: "media-error"; message: string }
  | { type: "error"; message: string };

type PeerParams = {
  output?: RealtimeVoiceAudioOutputPort;
  callbacks: OpenAIQuicksilverAudioPeerCallbacks;
  iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }>;
  signal?: AbortSignal;
};

export class OpenAIQuicksilverAudioPeer implements OpenAIQuicksilverAudioPeerContract {
  static async create(params: PeerParams): Promise<OpenAIQuicksilverAudioPeer> {
    params.signal?.throwIfAborted();
    const url = resolveRuntimeWorkerUrl({
      currentModuleUrl: import.meta.url,
      sourceWorkerName: "realtime-quicksilver-audio.worker",
      distWorkerPath: "extensions/openai/realtime-quicksilver-audio.worker.js",
      package: {
        name: "@openclaw/openai-provider",
        distWorkerPath: "realtime-quicksilver-audio.worker.js",
      },
    });
    const worker = new Worker(url, {
      workerData: {
        iceServers: params.iceServers,
        reportMediaErrors: Boolean(params.callbacks.onMediaError),
        output: params.output,
      },
      execArgv: resolveRuntimeWorkerArgv(url).slice(0, -1),
      transferList: params.output ? [params.output.port] : [],
    });
    const peer = new OpenAIQuicksilverAudioPeer(worker, params.callbacks, params.output);
    const abort = () => peer.close();
    params.signal?.addEventListener("abort", abort, { once: true });
    try {
      await peer.ready;
      params.signal?.throwIfAborted();
      return peer;
    } catch (error) {
      peer.close();
      params.signal?.throwIfAborted();
      throw error;
    } finally {
      params.signal?.removeEventListener("abort", abort);
    }
  }

  private closed = false;
  private started = false;
  private inputInFlight = false;
  private outputGeneration = 0;
  private pendingAudio = new OpenAIQuicksilverPendingAudio();
  private nextRequestId = 0;
  private readonly requests = new Map<
    number,
    { resolve(value: string): void; reject(error: Error): void }
  >();
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(
    private readonly worker: Worker,
    private readonly callbacks: OpenAIQuicksilverAudioPeerCallbacks,
    private readonly output?: RealtimeVoiceAudioOutputPort,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    worker.on("message", (message: QuicksilverAudioWorkerEvent) => {
      try {
        this.handleMessage(message);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    worker.on("error", (error) => this.fail(toErrorObject(error, "GPT-Live audio worker failed")));
    worker.on("exit", (code) => {
      if (this.closeTimer) {
        clearTimeout(this.closeTimer);
        this.closeTimer = undefined;
      }
      if (!this.closed) {
        this.fail(new Error("GPT-Live audio worker exited unexpectedly (code " + code + ")"));
      }
    });
  }

  createOffer(): Promise<string> {
    return this.request({ type: "offer", id: ++this.nextRequestId });
  }

  async applyAnswer(sdp: string): Promise<void> {
    await this.request({ type: "answer", id: ++this.nextRequestId, sdp });
  }

  adoptPendingAudio(pendingAudio: OpenAIQuicksilverPendingAudio): void {
    if (this.closed) {
      pendingAudio.clear();
      return;
    }
    if (this.inputInFlight || this.pendingAudio.length > 0) {
      pendingAudio.clear();
      throw new Error("GPT-Live WebRTC peer already owns pending audio");
    }
    this.pendingAudio = pendingAudio;
    this.flushInput();
  }

  sendAudio(audio: Buffer): void {
    if (this.closed) {
      return;
    }
    this.pendingAudio.append(audio);
    this.flushInput();
  }

  clearOutputAudio(): void {
    if (!this.closed) {
      this.post({ type: "clear-output", generation: ++this.outputGeneration });
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.output) {
      Atomics.store(new Int32Array(this.output.state, 0, 1), 0, 1);
    }
    this.pendingAudio.clear();
    const error = new Error("GPT-Live audio worker closed");
    this.rejectReady(error);
    for (const request of this.requests.values()) {
      request.reject(error);
    }
    this.requests.clear();
    // Cooperative cleanup frees Opus and closes sockets. Termination also bounds
    // shutdown if startup/import or a dependency never yields back to the worker.
    this.closeTimer = setTimeout(() => void this.worker.terminate(), 2_000);
    this.closeTimer.unref();
    this.post({ type: "close" });
    this.worker.unref();
  }

  private request(
    command: Extract<QuicksilverAudioWorkerCommand, { id: number }>,
  ): Promise<string> {
    if (this.closed) {
      return Promise.reject(new Error("GPT-Live audio worker closed"));
    }
    return new Promise((resolve, reject) => {
      this.requests.set(command.id, { resolve, reject });
      this.post(command);
    });
  }

  private post(command: QuicksilverAudioWorkerCommand, transfer: ArrayBuffer[] = []): void {
    // Node Worker messages have no browser targetOrigin. Only freshly allocated
    // audio storage is transferred; caller-owned and pooled buffers stay attached.
    this.worker.postMessage(command, transfer);
  }

  private flushInput(): void {
    if (this.closed || this.inputInFlight || this.pendingAudio.length === 0) {
      return;
    }
    const audio = Buffer.alloc(this.pendingAudio.length);
    this.pendingAudio.readInto(audio);
    this.inputInFlight = true;
    this.post({ type: "audio", audio }, [audio.buffer]);
  }

  private handleMessage(message: QuicksilverAudioWorkerEvent): void {
    if (this.closed) {
      return;
    }
    switch (message.type) {
      case "ready":
        this.started = true;
        this.resolveReady();
        return;
      case "result":
      case "request-error": {
        const request = this.requests.get(message.id);
        this.requests.delete(message.id);
        if (message.type === "result") {
          request?.resolve(message.value);
        } else {
          request?.reject(new Error(message.message));
        }
        return;
      }
      case "input-ack":
        this.inputInFlight = false;
        this.flushInput();
        return;
      case "audio":
        try {
          // A sideband clear can beat PCM already posted by the worker. Retire
          // delivery here immediately, but always return its output credit below.
          if (message.generation !== this.outputGeneration) {
            return;
          }
          this.callbacks.onAudio(
            Buffer.from(message.audio.buffer, message.audio.byteOffset, message.audio.byteLength),
          );
        } finally {
          if (!this.closed) {
            this.post({ type: "audio-ack" });
          }
        }
        return;
      case "rtp":
        try {
          this.callbacks.onRtpPacket?.();
        } finally {
          if (!this.closed) {
            this.post({ type: "rtp-ack" });
          }
        }
        return;
      case "media-error":
        try {
          this.callbacks.onMediaError?.(new Error(message.message));
        } finally {
          if (!this.closed) {
            this.post({ type: "media-error-ack" });
          }
        }
        return;
      case "error":
        this.fail(new Error(message.message));
    }
  }

  private fail(error: Error): void {
    if (this.closed) {
      return;
    }
    const started = this.started;
    this.rejectReady(error);
    this.close();
    if (started) {
      this.callbacks.onError(error);
    }
  }
}
