import type { MessagePort } from "node:worker_threads";
import {
  isRealtimeVoiceAudioAudible,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceAudioOutputMessage,
} from "openclaw/plugin-sdk/realtime-voice-provider";
import {
  DISCORD_AUDIO_CLOCK_BYTES,
  DISCORD_CONTINUOUS_ACTIVE,
  DISCORD_CONTINUOUS_SOURCE_BYTES,
  DISCORD_CONTINUOUS_EXACT_SPEECH,
  serializeDiscordAudioError,
  type DiscordAudioEvent,
} from "./audio-worker-protocol.js";
import { DiscordRealtimeOutput } from "./realtime-output.runtime.js";
import type { DiscordRealtimePlayer } from "./realtime-player.runtime.js";

/** A transferred endpoint is owned by one already-admitted provider generation.
 * No socket, response policy, credential, or speaker admission crosses this port. */
export class DiscordContinuousOutput {
  private readonly outputs = new Set<DiscordRealtimeOutput>();
  private generating?: DiscordRealtimeOutput;
  private closed = false;
  private enabled: boolean;

  constructor(
    private readonly params: {
      id: number;
      enabled: boolean;
      port: MessagePort;
      state: Int32Array;
      clock: BigInt64Array;
      player: DiscordRealtimePlayer;
      logContext: string;
      post: (event: DiscordAudioEvent) => void;
    },
  ) {
    this.enabled = params.enabled;
    params.port.on("message", (message: RealtimeVoiceAudioOutputMessage) => {
      try {
        if (this.closed || Atomics.load(params.state, 0) !== 0) {
          return;
        }
        if (message.type === "flushed") {
          params.post({ type: "continuous-flushed", id: params.id, marker: message.marker });
          return;
        }
        if (!this.enabled) {
          return;
        }
        if (message.type === "audio") {
          this.append(Buffer.from(message.audio));
        } else if (message.type === "clear") {
          this.clear();
        }
      } catch (error) {
        this.fail(error);
      } finally {
        if (message.type === "audio") {
          params.port.postMessage({ type: "ack" }, []);
        }
      }
    });
    params.port.on("messageerror", (error) => this.fail(error));
    params.port.on("close", () => this.close());
  }

  private append(audio: Buffer): void {
    if (!audio.length) {
      return;
    }
    if (this.generating && !this.generating.isAcceptingAudio()) {
      this.generating = undefined;
    }
    const audible = isRealtimeVoiceAudioAudible(audio, REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ);
    if (!audible && !this.generating) {
      return;
    }
    const pendingBytes = [...this.outputs].reduce(
      (total, output) => total + output.pendingBytes(),
      0,
    );
    if (
      pendingBytes + audio.length * 4 > 3_840 * 6_000 ||
      (!this.generating && this.outputs.size >= 32)
    ) {
      throw new Error("Discord realtime direct audio backlog exceeded.");
    }
    if (!this.generating) {
      const latch = Atomics.load(this.params.clock, DISCORD_CONTINUOUS_EXACT_SPEECH);
      const speechEpoch = latch < 0n ? -latch : latch;
      const output = new DiscordRealtimeOutput({
        player: this.params.player,
        clock: new BigInt64Array(new SharedArrayBuffer(DISCORD_AUDIO_CLOCK_BYTES)),
        continuous: true,
        logContext: this.params.logContext,
        isOpen: () => {
          const current = Atomics.load(this.params.clock, DISCORD_CONTINUOUS_EXACT_SPEECH);
          return (
            !this.closed &&
            this.enabled &&
            Atomics.load(this.params.state, 0) === 0 &&
            (current === speechEpoch || current === -speechEpoch)
          );
        },
        onStart: () => {
          // Capture ownership when the output is created, never from a delayed start callback.
          const current = Atomics.compareExchange(
            this.params.clock,
            DISCORD_CONTINUOUS_EXACT_SPEECH,
            speechEpoch,
            -speechEpoch,
          );
          if (current !== speechEpoch && current !== -speechEpoch) {
            output.close("exact-speech-retired");
            return;
          }
          this.params.post({ type: "continuous-start", id: this.params.id, speechEpoch });
        },
        onClose: (closed) => {
          this.outputs.delete(closed);
          if (this.generating === closed) {
            this.generating = undefined;
          }
          Atomics.store(this.params.clock, DISCORD_CONTINUOUS_ACTIVE, BigInt(this.outputs.size));
          if (this.outputs.size === 0) {
            Atomics.store(this.params.clock, DISCORD_CONTINUOUS_SOURCE_BYTES, 0n);
            this.params.post({ type: "continuous-idle", id: this.params.id, speechEpoch });
          }
        },
        onError: (error) => this.fail(error),
      });
      this.outputs.add(output);
      this.generating = output;
      Atomics.store(this.params.clock, DISCORD_CONTINUOUS_ACTIVE, BigInt(this.outputs.size));
    }
    Atomics.add(this.params.clock, DISCORD_CONTINUOUS_SOURCE_BYTES, BigInt(audio.length));
    this.generating.append(audio, audible);
  }

  activate(): void {
    this.enabled = true;
  }

  flush(marker: number): void {
    if (!this.closed) {
      this.params.port.postMessage({ type: "flush", marker }, []);
    }
  }

  clear(): void {
    this.generating = undefined;
    this.params.player.transition(() => {
      for (const output of [...this.outputs].toReversed()) {
        output.close("provider-clear");
      }
    });
  }
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    Atomics.store(this.params.state, 0, 1);
    this.clear();
    this.params.port.close();
  }
  private fail(error: unknown): void {
    if (this.closed) {
      return;
    }
    this.params.post({
      type: "continuous-error",
      id: this.params.id,
      error: serializeDiscordAudioError(error),
    });
    this.close();
  }
}
