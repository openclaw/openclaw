import { EventEmitter } from "node:events";
import type { WorkerOptions } from "node:worker_threads";
import type { DiscordAudioTransport } from "./audio-transport.js";
import type {
  DiscordAudioCommand,
  DiscordAudioEvent,
  DiscordAudioWorkerOptions,
} from "./audio-worker-protocol.js";
import { DiscordAudioWorker } from "./audio-worker.js";

/** Existing policy tests replace the thread, not its media owner or SDK contract. */
export class InProcessDiscordAudioWorker extends EventEmitter {
  readonly media: DiscordAudioWorker;
  private exited = false;
  constructor(_url: URL | undefined, options: WorkerOptions) {
    super();
    const data: DiscordAudioWorkerOptions = options.workerData;
    this.media = new DiscordAudioWorker(data, (event: DiscordAudioEvent) => {
      if (
        event.type === "capture-frame" ||
        event.type === "capture-error" ||
        event.type === "capture-end"
      ) {
        queueMicrotask(() => this.emit("message", event));
      } else {
        this.emit("message", event);
      }
      if (event.type === "stopped") {
        queueMicrotask(() => this.exit());
      }
    });
    queueMicrotask(() => {
      void this.media.connect().catch((error: unknown) => {
        this.emit("error", error);
        void this.media.stop();
      });
    });
  }
  postMessage(command: DiscordAudioCommand): void {
    this.media.receive(command);
  }
  async terminate(): Promise<number> {
    await this.media.stop();
    this.exit();
    return 0;
  }
  private exit(): void {
    if (!this.exited) {
      this.exited = true;
      this.emit("exit", 0);
    }
  }
}

export function getDiscordAudioTestWorker(audio: DiscordAudioTransport): DiscordAudioWorker {
  const worker = audio["worker"];
  if (!(worker instanceof InProcessDiscordAudioWorker)) {
    throw new Error("Expected in-process Discord media fixture");
  }
  return worker.media;
}
