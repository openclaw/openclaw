import {
  createRealtimeVoiceOutputActivityTracker,
  type RealtimeVoicePlaybackItem,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  DISCORD_AUDIO_CLOCK_BYTES,
  DISCORD_AUDIO_PLAYED_BYTES,
  DISCORD_AUDIO_STARTED,
  DiscordAudioOutputStatus,
  admitDiscordAudioInput,
  getDiscordAudioOutputStatus,
  releaseDiscordAudioInput,
  setDiscordAudioOutputStatus,
  restoreDiscordAudioError,
  type DiscordAudioEvent,
} from "./audio-worker-protocol.js";
import type { DiscordRealtimePlayer } from "./realtime-player.js";

/** Main retains provider item identity; physical output state belongs to the worker. */
export class DiscordRealtimeOutput {
  private readonly activityTracker = createRealtimeVoiceOutputActivityTracker();
  get activity() {
    if (
      Atomics.load(this.clock, DISCORD_AUDIO_STARTED) !== 0n &&
      !this.activityTracker.snapshot().playbackStarted
    ) {
      this.activityTracker.markPlaybackStarted();
    }
    return this.activityTracker;
  }
  private readonly clock = new BigInt64Array(new SharedArrayBuffer(DISCORD_AUDIO_CLOCK_BYTES));
  private readonly id: number;
  private readonly unregister: () => void;
  private readonly marks = new Map<number, () => void>();
  private nextMark = 0;
  private closed = false;
  private reportedPlaybackMs = 0;
  private readonly spans: Array<{
    item: RealtimeVoicePlaybackItem;
    startMs: number;
    endMs: number;
  }> = [];
  private readonly onEvent = (event: DiscordAudioEvent) => {
    if (!("id" in event) || event.id !== this.id || this.closed) {
      return;
    }
    switch (event.type) {
      case "output-start":
        this.activity.markPlaybackStarted();
        this.params.onStart();
        break;
      case "output-close":
        this.retire(event.reason);
        break;
      case "output-error":
        this.params.onError(restoreDiscordAudioError(event.error));
        break;
      case "output-mark": {
        const acknowledge = this.marks.get(event.markId);
        this.marks.delete(event.markId);
        try {
          acknowledge?.();
        } catch (error) {
          this.params.onError(error);
        }
        break;
      }
      case "capture-end":
      case "capture-error":
      case "capture-finalized":
      case "capture-frame":
      case "continuous-error":
      case "continuous-idle":
      case "continuous-flushed":
      case "continuous-start":
      case "file-end":
      case "stream-drain":
        // These IDs belong to other transport consumers.
        break;
    }
  };
  private readonly onStopped = () => {
    if (!this.closed) {
      this.params.onError(new Error("Discord audio worker stopped during playback."));
      this.retire("worker-stopped");
    }
  };

  constructor(
    private readonly params: {
      player: DiscordRealtimePlayer;
      continuous: boolean;
      onStart: () => void;
      onClose: (output: DiscordRealtimeOutput, reason: string) => void;
      onBargeIn: (reason: string) => boolean;
      onError: (error: unknown) => void;
    },
  ) {
    this.id = params.player.audio.allocateId();
    this.unregister = params.player.registerOutput(this.id, params.onBargeIn);
    params.player.audio.on("event", this.onEvent);
    params.player.audio.on("stopped", this.onStopped);
    params.player.audio.send({
      type: "output-create",
      id: this.id,
      continuous: params.continuous,
      clock: this.clock.buffer,
    });
  }

  private playedBytes(): number {
    return Number(Atomics.load(this.clock, DISCORD_AUDIO_PLAYED_BYTES));
  }
  pendingBytes(): number {
    return this.closed
      ? 0
      : Math.max(0, this.activity.snapshot().sourceAudioBytes * 4 - this.playedBytes());
  }
  isAcceptingAudio(): boolean {
    return (
      !this.closed &&
      !this.activity.snapshot().streamEnding &&
      getDiscordAudioOutputStatus(this.clock) < DiscordAudioOutputStatus.Retiring
    );
  }
  playbackItems(): RealtimeVoicePlaybackItem[] {
    const playedMs = Math.min(this.playedBytes() / 192, this.activity.snapshot().audioMs);
    for (const span of this.spans) {
      span.item.audioEndMs += Math.max(
        0,
        Math.min(playedMs, span.endMs) - Math.max(this.reportedPlaybackMs, span.startMs),
      );
    }
    this.reportedPlaybackMs = playedMs;
    return this.spans.filter(({ endMs }) => endMs > playedMs).map(({ item }) => item);
  }
  markPlayback(acknowledge: () => void): void {
    if (this.closed) {
      return;
    }
    const markId = ++this.nextMark;
    this.marks.set(markId, acknowledge);
    this.params.player.audio.send({ type: "output-mark", id: this.id, markId });
  }
  append(
    audio: Buffer,
    audible: boolean,
    item: RealtimeVoicePlaybackItem | undefined,
    onAccepted: () => void,
  ): boolean {
    if (
      this.closed ||
      this.activity.snapshot().streamEnding ||
      !admitDiscordAudioInput(this.clock)
    ) {
      return false;
    }
    try {
      onAccepted();
    } catch (error) {
      releaseDiscordAudioInput(this.clock);
      throw error;
    }
    // Observers may cancel synchronously after admission, before publication.
    if (this.closed) {
      releaseDiscordAudioInput(this.clock);
      return true;
    }
    const previous = this.activity.snapshot();
    const sinkBytes = Math.floor((previous.sourceAudioBytes + audio.length) / 2) * 8;
    const audioMs = (sinkBytes - previous.sinkAudioBytes) / 192;
    if (item) {
      const last = this.spans.at(-1);
      if (last?.item === item && last.endMs === previous.audioMs) {
        last.endMs += audioMs;
      } else {
        this.spans.push({ item, startMs: previous.audioMs, endMs: previous.audioMs + audioMs });
      }
    }
    this.activity.markAudio({
      audioMs,
      sourceAudioBytes: audio.length,
      sinkAudioBytes: sinkBytes - previous.sinkAudioBytes,
    });
    this.params.player.audio.send({ type: "output-audio", id: this.id, audio, audible });
    return true;
  }
  finish(reason: string, playBuffered: boolean): void {
    if (this.closed) {
      return;
    }
    this.activity.markStreamEnding();
    if (!playBuffered) {
      setDiscordAudioOutputStatus(this.clock, DiscordAudioOutputStatus.Closed);
    }
    this.params.player.audio.send({ type: "output-finish", id: this.id, reason, playBuffered });
    if (!playBuffered) {
      this.retire(reason);
    }
  }
  close(reason: string): void {
    if (this.closed) {
      return;
    }
    setDiscordAudioOutputStatus(this.clock, DiscordAudioOutputStatus.Closed);
    this.params.player.audio.send({ type: "output-close", id: this.id, reason });
    this.retire(reason);
  }
  private retire(reason: string): void {
    if (this.closed) {
      return;
    }
    this.playbackItems();
    this.closed = true;
    this.marks.clear();
    this.params.player.audio.off("event", this.onEvent);
    this.params.player.audio.off("stopped", this.onStopped);
    this.unregister();
    this.params.onClose(this, reason);
  }
}
