import type { DiscordAudioTransport } from "./audio-transport.js";
import type { DiscordAudioEvent } from "./audio-worker-protocol.js";

type DiscordRealtimePlayerLane = {
  hasOutput: () => boolean;
  onBargeIn: (reason: string) => boolean;
  cancelForControl: () => void;
};

/** Room-level policy stays on main; the worker owns the physical player and FIFO. */
export class DiscordRealtimePlayer {
  private readonly lanes = new Set<DiscordRealtimePlayerLane>();
  private readonly outputs = new Map<number, (reason: string) => boolean>();
  private current?: number;
  private closed = false;
  private readonly onEvent = (event: DiscordAudioEvent) => {
    if (event.type === "output-start" || event.type === "continuous-start") {
      this.current = event.id;
    }
    if (
      (event.type === "output-close" || event.type === "continuous-idle") &&
      this.current === event.id
    ) {
      this.current = undefined;
    }
  };

  constructor(readonly audio: DiscordAudioTransport) {
    audio.on("event", this.onEvent);
  }

  registerLane(lane: DiscordRealtimePlayerLane): () => void {
    this.lanes.add(lane);
    return () => this.lanes.delete(lane);
  }
  registerOutput(id: number, onBargeIn: (reason: string) => boolean): () => void {
    this.outputs.set(id, onBargeIn);
    return () => {
      this.outputs.delete(id);
      if (this.current === id) {
        this.current = undefined;
      }
    };
  }
  handleBargeIn(reason = "barge-in"): boolean {
    const current = this.current === undefined ? undefined : this.outputs.get(this.current);
    if (current) {
      return current(reason);
    }
    let interrupted = false;
    for (const lane of [...this.lanes].filter((candidate) => candidate.hasOutput())) {
      interrupted = lane.onBargeIn(reason) || interrupted;
    }
    return interrupted;
  }
  isActive(): boolean {
    return this.current !== undefined || [...this.lanes].some((lane) => lane.hasOutput());
  }
  cancelForControl(): void {
    this.transition(() => {
      for (const lane of this.lanes) {
        lane.cancelForControl();
      }
    });
  }
  transition(action: () => void): void {
    this.audio.send({ type: "output-hold", hold: true });
    try {
      action();
    } finally {
      this.audio.send({ type: "output-hold", hold: false });
    }
  }
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.lanes.clear();
    this.outputs.clear();
    this.current = undefined;
    this.audio.off("event", this.onEvent);
    this.audio.send({ type: "output-shutdown" });
  }
}
