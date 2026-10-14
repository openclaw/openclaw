import { PassThrough, pipeline } from "node:stream";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createRealtimeVoiceOutputActivityTracker } from "openclaw/plugin-sdk/realtime-voice-playback";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  DISCORD_AUDIO_PLAYED_BYTES,
  DISCORD_AUDIO_STARTED,
  DiscordAudioOutputStatus,
  getDiscordAudioOutputStatus,
  setDiscordAudioOutputStatus,
} from "./audio-worker-protocol.js";
import { DiscordOpusEncodeStream, createRealtimePcmToDiscordConverter } from "./audio.js";
import { resolveDiscordOutputAudioDelta } from "./output-activity.js";
import {
  DISCORD_REALTIME_PLAYBACK_IDLE_MS,
  type DiscordRealtimePlayer,
  type DiscordRealtimePlayerRequest,
} from "./realtime-player.runtime.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";

const logger = createSubsystemLogger("discord/voice");
const DISCORD_RAW_PCM_FRAME_BYTES = 3_840;
const DISCORD_REALTIME_OUTPUT_PREROLL_FRAMES = 25;
// Cover the provider's 80 ms reorder window plus two Discord playback ticks.
const DISCORD_CONTINUOUS_PREROLL_FRAMES = 6;
const DISCORD_CONTINUOUS_START_DEADLINE_MS = DISCORD_CONTINUOUS_PREROLL_FRAMES * 20;
// Leave room for the realtime player's two-second missed-frame tolerance.
const DISCORD_REALTIME_OUTPUT_PLAYBACK_WATCHDOG_MARGIN_MS = 3_000;

/** One output stream retains ownership through queued and audible playback. */
export class DiscordRealtimeOutput {
  readonly activity = createRealtimeVoiceOutputActivityTracker({
    now: () => performance.now(),
  });
  private readonly converter = createRealtimePcmToDiscordConverter();
  private readonly stream = new PassThrough({ highWaterMark: DISCORD_RAW_PCM_FRAME_BYTES * 128 });
  private request: DiscordRealtimePlayerRequest | undefined;
  private ready = false;
  private playbackMarks: Array<{ endBytes: number; acknowledge: () => void }> = [];
  private playedPcmBytes = 0;
  private lastAudiblePcmEndBytes = 0;
  private buffers: Buffer[] = [];
  private bufferedBytes = 0;
  private drainHandler: (() => void) | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private silentSince: number | undefined;
  private closed = false;
  private failed = false;

  constructor(
    private readonly params: {
      player: DiscordRealtimePlayer;
      clock: BigInt64Array;
      logContext: string;
      continuous: boolean;
      isOpen?: () => boolean;
      onStart: () => void;
      onClose: (output: DiscordRealtimeOutput, reason: string) => void;
      onError: (error: unknown) => void;
    },
  ) {
    this.stream.once("close", () => {
      // Encoding can finish before the player consumes the resource. Idle owns
      // completion after playback starts, even if the PCM stream has closed.
      if (!this.activity.snapshot().playbackStarted) {
        this.close("stream-close");
      }
    });
  }

  pendingBytes(): number {
    return this.closed
      ? 0
      : Math.max(0, this.activity.snapshot().sourceAudioBytes * 4 - this.playedPcmBytes);
  }

  isAcceptingAudio(): boolean {
    return (
      !this.closed &&
      getDiscordAudioOutputStatus(this.params.clock) < DiscordAudioOutputStatus.Retiring &&
      !this.activity.snapshot().streamEnding &&
      (!this.request || !this.params.player.isRetiring(this.request))
    );
  }

  private hasUnplayedAudibleAudio(): boolean {
    return !this.closed && this.playedPcmBytes < this.lastAudiblePcmEndBytes;
  }

  markPlayback(acknowledge: () => void): void {
    if (!this.closed) {
      this.playbackMarks.push({ endBytes: this.activity.snapshot().sinkAudioBytes, acknowledge });
    }
  }

  append(sourcePcm: Buffer, audible: boolean): void {
    if (!this.isAcceptingAudio()) {
      return;
    }
    this.activity.markAudio(
      resolveDiscordOutputAudioDelta(this.activity.snapshot(), sourcePcm.length),
    );
    if (audible) {
      this.clearTimer("silenceTimer");
      this.silentSince = undefined;
      this.lastAudiblePcmEndBytes = this.activity.snapshot().sinkAudioBytes;
    }
    this.writeConverted(this.converter.process(sourcePcm));
    this.scheduleSilenceRetirement();
    if (this.params.continuous) {
      this.enqueuePlayback();
    }
    const prerollFrames = this.params.continuous
      ? DISCORD_CONTINUOUS_PREROLL_FRAMES
      : DISCORD_REALTIME_OUTPUT_PREROLL_FRAMES;
    if (this.activity.snapshot().sinkAudioBytes >= DISCORD_RAW_PCM_FRAME_BYTES * prerollFrames) {
      this.startPlayback();
    } else if (this.params.continuous && !this.ready && !this.startupTimer) {
      // Continuous providers may never send response.done, including short replies.
      this.startupTimer = setTimeout(() => {
        this.startupTimer = undefined;
        this.startPlayback();
      }, DISCORD_CONTINUOUS_START_DEADLINE_MS);
      this.startupTimer.unref?.();
    }
  }

  private writeConverted(pcm: Buffer): void {
    if (pcm.length === 0 || this.closed) {
      return;
    }
    if (this.activity.snapshot().playbackStarted && !this.drainHandler) {
      // A false write return accepts this chunk; only later chunks are queued.
      if (!this.stream.write(pcm)) {
        this.waitForDrain();
      }
      return;
    }
    this.buffers.push(pcm);
    this.bufferedBytes += pcm.length;
  }

  finish(reason: string, playBuffered: boolean): void {
    if (this.closed) {
      return;
    }
    this.publishRetiring();
    this.clearTimer("silenceTimer");
    if (playBuffered) {
      this.writeConverted(this.converter.flush());
    }
    this.activity.markStreamEnding();
    const activity = this.activity.snapshot();
    logger.info(
      `discord voice: realtime audio playback finishing reason=${reason} ${this.params.logContext} audioMs=${Math.floor(activity.audioMs)} chunks=${activity.chunks}`,
    );
    if (!playBuffered) {
      this.close(reason);
      return;
    }
    this.startPlayback();
    if (this.activity.snapshot().playbackStarted) {
      this.scheduleWatchdog(reason);
      if (!this.drainHandler) {
        this.stream.end();
      }
    }
  }

  close(reason: string): void {
    if (this.closed) {
      return;
    }
    const playbackRetirement =
      reason === "player-idle" ||
      reason === "output-pipeline-error" ||
      reason === "playback-watchdog";
    const heardMarks = playbackRetirement
      ? this.playbackMarks.filter((mark) => mark.endBytes <= this.playedPcmBytes)
      : [];
    const lostPlaybackMarks =
      playbackRetirement && this.playbackMarks.some((mark) => mark.endBytes > this.playedPcmBytes);
    this.closed = true;
    setDiscordAudioOutputStatus(this.params.clock, DiscordAudioOutputStatus.Closed);
    this.clearTimer("silenceTimer");
    this.clearTimer("startupTimer");
    this.playbackMarks = [];
    this.clearTimer("watchdog");
    const activity = this.activity.snapshot();
    logger.info(
      `discord voice: realtime audio playback stopped reason=${reason} ${this.params.logContext} audioMs=${Math.floor(activity.audioMs)} elapsedMs=${this.activity.elapsedPlaybackMs()} chunks=${activity.chunks} discordBytes=${activity.sinkAudioBytes} realtimeBytes=${activity.sourceAudioBytes}`,
    );
    this.buffers = [];
    this.bufferedBytes = 0;
    if (this.drainHandler) {
      this.stream.off("drain", this.drainHandler);
      this.drainHandler = undefined;
    }
    this.stream.end();
    this.stream.destroy();
    if (lostPlaybackMarks) {
      this.params.onError(
        new Error(`Discord realtime audio stopped before playback completed: ${reason}`),
      );
    }
    // Retire the exact output before stop can synchronously grant another one.
    this.params.onClose(this, reason);
    if (this.request) {
      this.params.player.cancel(this.request);
      this.request = undefined;
    }
    // Idle can retire the resource before its final read microtask. Preserve
    // heard acknowledgments after retirement, never report discarded PCM as played.
    try {
      for (const mark of heardMarks) {
        mark.acknowledge();
      }
    } catch (error) {
      this.params.onError(error);
    }
  }

  private startPlayback(): void {
    if (this.closed || this.ready) {
      return;
    }
    this.clearTimer("startupTimer");
    if (this.bufferedBytes < DISCORD_RAW_PCM_FRAME_BYTES) {
      this.writeConverted(this.converter.drain());
    }
    this.ready = true;
    this.enqueuePlayback();
  }

  private publishRetiring(): void {
    if (!this.closed) {
      setDiscordAudioOutputStatus(this.params.clock, DiscordAudioOutputStatus.Retiring);
    }
  }

  private enqueuePlayback(): void {
    this.request ??= {
      isReady: () => this.ready,
      createResource: () => this.createResource(),
      onStart: () => {
        this.activity.markPlaybackStarted();
        setDiscordAudioOutputStatus(
          this.params.clock,
          this.activity.snapshot().streamEnding
            ? DiscordAudioOutputStatus.Retiring
            : DiscordAudioOutputStatus.Playing,
        );
        Atomics.store(this.params.clock, DISCORD_AUDIO_STARTED, 1n);
        this.params.onStart();
        if (this.activity.snapshot().streamEnding) {
          this.scheduleWatchdog("player-start");
          if (!this.drainHandler) {
            this.stream.end();
          }
        }
      },
      onRetiring: () => {
        if (this.activity.snapshot().sinkAudioBytes > this.playedPcmBytes) {
          return false;
        }
        this.publishRetiring();
        return true;
      },
      onIdle: () => this.close(this.failed ? "output-pipeline-error" : "player-idle"),
      onError: this.params.onError,
    };
    this.params.player.enqueue(this.request);
  }

  private createResource() {
    const voiceSdk = loadDiscordVoiceSdk();
    const opusStream = new DiscordOpusEncodeStream();
    // The SDK emits Idle on error before the pipeline completion callback runs.
    opusStream.once("error", () => {
      this.failed = true;
    });
    pipeline(this.stream, opusStream, (error) => {
      if (!error || this.closed) {
        return;
      }
      logger.warn(
        `discord voice: realtime output pipeline failed ${this.params.logContext}: ${formatErrorMessage(error)}`,
      );
      this.close("output-pipeline-error");
    });
    const buffered = Buffer.concat(this.buffers, this.bufferedBytes);
    this.buffers = [];
    this.bufferedBytes = 0;
    if (buffered.length > 0 && !this.stream.write(buffered)) {
      this.waitForDrain();
    }
    if (
      this.params.continuous &&
      buffered.length > 0 &&
      buffered.length < DISCORD_RAW_PCM_FRAME_BYTES
    ) {
      // The player cannot read to flush a partial packet until its first packet exists.
      opusStream.flushPartialFrameWhenReady();
    }
    const resource = voiceSdk.createAudioResource(opusStream, {
      inputType: voiceSdk.StreamType.Opus,
    });
    const read = resource.read.bind(resource);
    resource.read = () => {
      if (
        this.params.isOpen?.() === false ||
        getDiscordAudioOutputStatus(this.params.clock) === DiscordAudioOutputStatus.Closed
      ) {
        this.close("port-closed");
        return null;
      }
      let packet: Buffer | null;
      try {
        packet = read();
        // Drain a partial frame only when playback needs it, never on chunk arrival.
        if (!packet && opusStream.flushPartialFrame()) {
          packet = read();
        }
        if (packet) {
          // SDK cleanup reads the stream directly after destroy; only player reads
          // count as heard. SDK-generated silence has no source PCM metadata.
          this.playedPcmBytes += opusStream.takePcmBytes(packet);
          Atomics.store(this.params.clock, DISCORD_AUDIO_PLAYED_BYTES, BigInt(this.playedPcmBytes));
          if (resource.silenceRemaining >= 0) {
            this.publishRetiring();
          }
          const remaining = this.activity.snapshot().sinkAudioBytes - this.playedPcmBytes;
          if (remaining > 0 && remaining <= DISCORD_RAW_PCM_FRAME_BYTES) {
            // Render the held filter tail before the last packet is needed, giving
            // the yielding encoder one playback tick to prepare it.
            this.writeConverted(this.converter.drain());
          }
          this.scheduleSilenceRetirement();
        }
      } catch (error) {
        opusStream.destroy(error instanceof Error ? error : new Error(formatErrorMessage(error)));
        return null;
      }
      if (this.playbackMarks.length > 0) {
        // Finish the SDK's packet preparation before an acknowledgment can start
        // another response or synchronously cancel this output.
        queueMicrotask(() => this.acknowledgePlayedMarks());
      }
      return packet;
    };
    return resource;
  }

  private acknowledgePlayedMarks(): void {
    try {
      while (!this.closed) {
        const mark = this.playbackMarks[0];
        if (!mark || mark.endBytes > this.playedPcmBytes) {
          return;
        }
        this.playbackMarks.shift();
        mark.acknowledge();
      }
    } catch (error) {
      this.params.onError(error);
    }
  }

  private scheduleSilenceRetirement(): void {
    const activity = this.activity.snapshot();
    if (
      !this.params.continuous ||
      this.closed ||
      activity.streamEnding ||
      !activity.playbackStarted ||
      this.hasUnplayedAudibleAudio()
    ) {
      return;
    }
    this.silentSince ??= performance.now();
    // Source silence preserves pauses but must not keep an idle speaker's lane forever.
    // Without source silence, the SDK still owns ordinary packet-starvation retirement.
    if (activity.sinkAudioBytes <= this.lastAudiblePcmEndBytes || this.silenceTimer) {
      return;
    }
    this.silenceTimer = setTimeout(
      () => {
        this.silenceTimer = undefined;
        if (
          !this.closed &&
          !this.activity.snapshot().streamEnding &&
          !this.hasUnplayedAudibleAudio()
        ) {
          this.finish("continuous-idle", true);
        }
      },
      Math.max(0, DISCORD_REALTIME_PLAYBACK_IDLE_MS - (performance.now() - this.silentSince)),
    );
    this.silenceTimer.unref?.();
  }

  private clearTimer(timer: "silenceTimer" | "startupTimer" | "watchdog"): void {
    clearTimeout(this[timer]);
    this[timer] = undefined;
  }

  private waitForDrain(): void {
    if (this.drainHandler || this.closed) {
      return;
    }
    logger.info(
      `discord voice: realtime audio playback buffering ${this.params.logContext} bufferedBytes=${this.stream.writableLength + this.stream.readableLength}`,
    );
    this.drainHandler = () => {
      this.drainHandler = undefined;
      if (this.closed) {
        return;
      }
      let refreshWatchdog = this.activity.snapshot().streamEnding;
      for (let buffered = this.buffers.shift(); buffered; buffered = this.buffers.shift()) {
        this.bufferedBytes -= buffered.length;
        const writable = this.stream.write(buffered);
        if (refreshWatchdog) {
          this.scheduleWatchdog("output-drain");
          refreshWatchdog = false;
        }
        if (!writable) {
          this.waitForDrain();
          return;
        }
      }
      if (this.activity.snapshot().streamEnding) {
        this.stream.end();
      }
    };
    this.stream.once("drain", this.drainHandler);
  }

  private scheduleWatchdog(reason: string): void {
    this.clearTimer("watchdog");
    const timeoutMs = this.activity.playbackWatchdogDelayMs({
      marginMs: DISCORD_REALTIME_OUTPUT_PLAYBACK_WATCHDOG_MARGIN_MS,
      minMs: DISCORD_REALTIME_OUTPUT_PLAYBACK_WATCHDOG_MARGIN_MS,
    });
    if (timeoutMs === undefined) {
      return;
    }
    this.watchdog = setTimeout(() => {
      this.watchdog = undefined;
      logger.warn(
        `discord voice: realtime audio playback watchdog fired reason=${reason} ${this.params.logContext} audioMs=${Math.floor(this.activity.snapshot().audioMs)} elapsedMs=${this.activity.elapsedPlaybackMs()}`,
      );
      this.close("playback-watchdog");
    }, timeoutMs);
  }
}
