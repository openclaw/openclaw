export const PCM16_MONO_24KHZ_BYTES_PER_MILLISECOND = 48;
const OUTPUT_LATENCY_BUDGET_MS = 100;

type PlaybackSegment = {
  audioEndMs: number;
  audioStartMs: number;
  wallEndMs: number;
  wallStartMs: number;
};

export function schedulePlaybackSegment(params: {
  audioDurationMs: number;
  generatedAudioMs: number;
  nowMs: number;
  playbackUntilMs: number;
}): PlaybackSegment {
  const wallStartMs =
    params.nowMs < params.playbackUntilMs
      ? params.playbackUntilMs
      : params.nowMs + OUTPUT_LATENCY_BUDGET_MS;
  return {
    audioEndMs: params.generatedAudioMs + params.audioDurationMs,
    audioStartMs: params.generatedAudioMs,
    wallEndMs: wallStartMs + params.audioDurationMs,
    wallStartMs,
  };
}

export function calculatePlayedAudioMs(params: {
  nowMs: number;
  segments: readonly PlaybackSegment[];
}): number {
  let playedAudioMs = 0;
  for (const segment of params.segments) {
    if (params.nowMs <= segment.wallStartMs) {
      break;
    }
    const playedInSegmentMs = Math.min(
      segment.audioEndMs - segment.audioStartMs,
      params.nowMs - segment.wallStartMs,
    );
    playedAudioMs = segment.audioStartMs + playedInSegmentMs;
  }
  return Math.max(0, playedAudioMs);
}

export function resolvePlaybackMediaTimestamp(params: {
  responseStartTimestampMs: number;
  playedAudioMs: number;
}): number {
  return Math.floor(params.responseStartTimestampMs + Math.max(0, params.playedAudioMs));
}

export class PlaybackClock {
  private generatedAudioMs = 0;
  private playbackUntilMs = 0;
  private readonly segments: PlaybackSegment[] = [];

  append(byteLength: number, nowMs = Date.now()): void {
    const segment = schedulePlaybackSegment({
      audioDurationMs: byteLength / PCM16_MONO_24KHZ_BYTES_PER_MILLISECOND,
      generatedAudioMs: this.generatedAudioMs,
      nowMs,
      playbackUntilMs: this.playbackUntilMs,
    });
    this.generatedAudioMs = segment.audioEndMs;
    this.playbackUntilMs = segment.wallEndMs;
    const previous = this.segments.at(-1);
    if (
      previous?.wallEndMs === segment.wallStartMs &&
      previous.audioEndMs === segment.audioStartMs
    ) {
      previous.audioEndMs = segment.audioEndMs;
      previous.wallEndMs = segment.wallEndMs;
      return;
    }
    this.segments.push(segment);
  }

  playedAudioMs(nowMs = Date.now()): number {
    return calculatePlayedAudioMs({ nowMs, segments: this.segments });
  }

  totalGeneratedAudioMs(): number {
    return this.generatedAudioMs;
  }

  queuedAudioMs(nowMs = Date.now()): number {
    return Math.max(0, this.generatedAudioMs - this.playedAudioMs(nowMs));
  }

  millisecondsUntilDrained(nowMs = Date.now()): number {
    return Math.max(0, this.playbackUntilMs - nowMs);
  }

  reset(): void {
    this.generatedAudioMs = 0;
    this.playbackUntilMs = 0;
    this.segments.length = 0;
  }
}
