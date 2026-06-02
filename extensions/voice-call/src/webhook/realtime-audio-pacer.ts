const TELEPHONY_SAMPLE_RATE = 8_000;
const TELEPHONY_CHUNK_BYTES = 160;
const TELEPHONY_CHUNK_MS = 20;
const DEFAULT_SPEECH_RMS_THRESHOLD = 0.035;
const DEFAULT_REQUIRED_LOUD_CHUNKS = 4;
const DEFAULT_REQUIRED_QUIET_CHUNKS = 12;
const DEFAULT_MAX_QUEUED_AUDIO_BYTES = TELEPHONY_SAMPLE_RATE * 120;
const PCM16_MAX_AMPLITUDE = 32768;
const MULAW_LINEAR_SAMPLES = new Int16Array(256);

// Decode table is process-stable and hot-path reused by the speech detector;
// build it once instead of recomputing mu-law expansion per audio sample.
for (let i = 0; i < MULAW_LINEAR_SAMPLES.length; i += 1) {
  MULAW_LINEAR_SAMPLES[i] = decodeMulawSample(i);
}

type RealtimeAudioQueueItem =
  | {
      chunk: Buffer;
      durationMs: number;
      type: "audio";
    }
  | {
      name: string;
      type: "mark";
    };

/** Sends one serialized provider media/control frame; false means the socket can no longer accept output. */
export type RealtimeAudioSend = (message: string) => boolean;

/** Serializes provider-specific realtime media control envelopes. */
export interface RealtimeAudioSerializer {
  /** Wraps one base64 PCMU frame in the provider's outbound media envelope. */
  media(payloadBase64: string): string;
  /** Builds the provider command that drops queued carrier-side audio. */
  clear(): string;
  /** Builds a provider mark/control frame emitted after preceding paced audio. */
  mark(name: string): string;
}

/** Paces mu-law telephony output so realtime providers receive one 20ms frame at a time. */
export class RealtimeAudioPacer {
  private queue: RealtimeAudioQueueItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queuedAudioBytes = 0;
  private closed = false;

  constructor(
    private readonly params: {
      /** Maximum queued PCMU bytes before playback is abandoned and backpressure fires. */
      maxQueuedAudioBytes?: number;
      /** Called once the pacer closes because outbound audio outran the provider socket. */
      onBackpressure?: () => void;
      /** Sends serialized frames to the provider socket; returning false drops remaining playback. */
      send: RealtimeAudioSend;
      /** Provider-specific media/clear/mark serializer, usually bound to the stream id. */
      serializer: RealtimeAudioSerializer;
    },
  ) {}

  /** Queues provider-ready mu-law bytes and starts the pacing pump if needed. */
  sendAudio(muLaw: Buffer): void {
    if (this.closed || muLaw.length === 0) {
      return;
    }
    const maxQueuedAudioBytes = this.params.maxQueuedAudioBytes ?? DEFAULT_MAX_QUEUED_AUDIO_BYTES;
    for (let offset = 0; offset < muLaw.length; offset += TELEPHONY_CHUNK_BYTES) {
      // Queue an owned copy so callers can safely reuse or mutate their source buffer.
      const chunk = Buffer.from(muLaw.subarray(offset, offset + TELEPHONY_CHUNK_BYTES));
      if (this.queuedAudioBytes + chunk.length > maxQueuedAudioBytes) {
        // Once provider output falls too far behind, close instead of sending a partial response.
        this.failBackpressure();
        return;
      }
      this.queue.push({
        type: "audio",
        chunk,
        durationMs: Math.max(1, Math.round((chunk.length / TELEPHONY_SAMPLE_RATE) * 1000)),
      });
      this.queuedAudioBytes += chunk.length;
    }
    this.ensurePump();
  }

  /** Queues a provider mark after any earlier audio frames. */
  sendMark(name: string): void {
    if (this.closed || !name) {
      return;
    }
    this.queue.push({ type: "mark", name });
    this.ensurePump();
  }

  /** Drops unsent audio/marks and emits the provider clear command. */
  clearAudio(): number {
    if (this.closed) {
      return 0;
    }
    const clearedAudioBytes = this.queuedAudioBytes;
    this.clearTimer();
    this.queue = [];
    this.queuedAudioBytes = 0;
    this.params.send(this.params.serializer.clear());
    return clearedAudioBytes;
  }

  /** Stops future sends and releases queued audio. */
  close(): void {
    this.closed = true;
    this.clearTimer();
    this.queue = [];
    this.queuedAudioBytes = 0;
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
  }

  private ensurePump(): void {
    if (!this.timer) {
      this.pump();
    }
  }

  private failBackpressure(): void {
    this.close();
    this.params.onBackpressure?.();
  }

  private pump(): void {
    this.timer = null;
    if (this.closed) {
      return;
    }
    const item = this.queue.shift();
    if (!item) {
      return;
    }

    let delayMs = 0;
    let sent;
    if (item.type === "audio") {
      this.queuedAudioBytes = Math.max(0, this.queuedAudioBytes - item.chunk.length);
      sent = this.params.send(this.params.serializer.media(item.chunk.toString("base64")));
      delayMs = item.durationMs || TELEPHONY_CHUNK_MS;
    } else {
      sent = this.params.send(this.params.serializer.mark(item.name));
    }

    if (!sent) {
      // Treat a failed send as terminal for queued playback. Keeping stale audio
      // queued after provider backpressure would play the wrong turn later.
      this.queue = [];
      this.queuedAudioBytes = 0;
      return;
    }
    if (this.queue.length > 0) {
      this.timer = setTimeout(() => this.pump(), delayMs);
    }
  }
}

/** Calculates normalized RMS for 8kHz mu-law frames using the same lookup table as the pacer. */
export function calculateMulawRms(muLaw: Buffer): number {
  if (muLaw.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const sample of muLaw) {
    const normalized = (MULAW_LINEAR_SAMPLES[sample] ?? 0) / PCM16_MAX_AMPLITUDE;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / muLaw.length);
}

/** Edge detector for caller speech starts, debounced across loud and quiet telephony chunks. */
export class RealtimeMulawSpeechStartDetector {
  private loudChunks = 0;
  private quietChunks = DEFAULT_REQUIRED_QUIET_CHUNKS;
  private speaking = false;

  constructor(
    private readonly params: {
      /** Consecutive loud chunks required before reporting the speech-start edge. */
      requiredLoudChunks?: number;
      /** Consecutive quiet chunks required before arming the next speech-start edge. */
      requiredQuietChunks?: number;
      /** Normalized mu-law RMS threshold that separates silence/noise from speech. */
      rmsThreshold?: number;
    } = {},
  ) {}

  /** Returns true only on the transition from quiet/not-speaking to sustained speech. */
  accept(muLaw: Buffer): boolean {
    const rms = calculateMulawRms(muLaw);
    const threshold = this.params.rmsThreshold ?? DEFAULT_SPEECH_RMS_THRESHOLD;
    if (rms >= threshold) {
      this.quietChunks = 0;
      this.loudChunks += 1;
      const requiredLoudChunks = this.params.requiredLoudChunks ?? DEFAULT_REQUIRED_LOUD_CHUNKS;
      if (!this.speaking && this.loudChunks >= requiredLoudChunks) {
        this.speaking = true;
        return true;
      }
      return false;
    }

    this.loudChunks = 0;
    this.quietChunks += 1;
    const requiredQuietChunks = this.params.requiredQuietChunks ?? DEFAULT_REQUIRED_QUIET_CHUNKS;
    if (this.quietChunks >= requiredQuietChunks) {
      // Require sustained quiet before arming the next speech-start edge, so
      // brief pauses inside one utterance do not trigger repeated barge-ins.
      this.speaking = false;
    }
    return false;
  }
}

function decodeMulawSample(value: number): number {
  const muLaw = ~value & 0xff;
  const sign = muLaw & 0x80;
  const exponent = (muLaw >> 4) & 0x07;
  const mantissa = muLaw & 0x0f;
  let sample = ((mantissa << 3) + 132) << exponent;
  sample -= 132;
  return sign ? -sample : sample;
}
