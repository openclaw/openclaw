import {
  createStreamingPcmResampler,
  mulawToPcm,
  pcmToMulaw,
  type RealtimeVoiceBridgeCreateRequest,
} from "openclaw/plugin-sdk/realtime-voice-provider";

const RELAY_FRAME_SAMPLES = 480;
const MAX_PENDING_RELAY_FRAMES = 250;

export const OPENAI_QUICKSILVER_AUDIO_FRAME_DURATION_MS = 20;
export const OPENAI_QUICKSILVER_RELAY_FRAME_BYTES = RELAY_FRAME_SAMPLES * 2;
// One five-second tail spans peer startup and the connected media pump.
// Keeping the newest PCM bounds latency without changing policy at adoption.
const OPENAI_QUICKSILVER_MAX_PENDING_AUDIO_BYTES =
  OPENAI_QUICKSILVER_RELAY_FRAME_BYTES * MAX_PENDING_RELAY_FRAMES;

export function assertOpenAIQuicksilverPcmOutput(
  format: RealtimeVoiceBridgeCreateRequest["audioFormat"],
): void {
  if (
    format &&
    (format.encoding !== "pcm16" || format.sampleRateHz !== 24_000 || format.channels !== 1)
  ) {
    throw new Error("GPT-Live direct audio output requires mono PCM16 at 24 kHz");
  }
}

/** Keeps telephony resampling state and its delayed output tail with the audio adapter. */
export class OpenAIQuicksilverAudioAdapter {
  private readonly telephony: boolean;
  private inbound = createStreamingPcmResampler(8_000, 24_000);
  private outbound = createStreamingPcmResampler(24_000, 8_000);

  constructor(
    private readonly config: Pick<RealtimeVoiceBridgeCreateRequest, "audioFormat" | "onAudio">,
  ) {
    this.telephony = config.audioFormat?.encoding === "g711_ulaw";
  }

  decodeInput(audio: Buffer): Buffer {
    return this.telephony ? this.inbound.process(mulawToPcm(audio)) : audio;
  }

  sendOutput(pcm: Buffer): void {
    const audio = this.telephony ? pcmToMulaw(this.outbound.process(pcm)) : pcm;
    if (audio.length > 0) {
      this.config.onAudio(audio);
    }
  }

  finishOutput(): void {
    if (!this.telephony) {
      return;
    }
    const tail = pcmToMulaw(this.outbound.flush());
    this.outbound = createStreamingPcmResampler(24_000, 8_000);
    if (tail.length > 0) {
      this.config.onAudio(tail);
    }
  }

  reset(): void {
    this.inbound = createStreamingPcmResampler(8_000, 24_000);
    this.outbound = createStreamingPcmResampler(24_000, 8_000);
  }
}

/** One real-time clock for WebSocket PCM and WebRTC RTP; stalls never drain capture in a burst. */
export class OpenAIQuicksilverAudioClock {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly onFrame: (skippedFrames: number) => void) {}

  start(): void {
    if (this.timer) {
      return;
    }
    let nextFrameAt = performance.now();
    const tick = () => {
      const skippedFrames = Math.max(
        0,
        Math.floor((performance.now() - nextFrameAt) / OPENAI_QUICKSILVER_AUDIO_FRAME_DURATION_MS),
      );
      nextFrameAt += (skippedFrames + 1) * OPENAI_QUICKSILVER_AUDIO_FRAME_DURATION_MS;
      // Publish before delivery so synchronous teardown also cancels the first tick's successor.
      this.timer = setTimeout(tick, Math.max(0, nextFrameAt - performance.now()));
      this.timer.unref?.();
      this.onFrame(skippedFrames);
    };
    tick();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

export class OpenAIQuicksilverPendingAudio {
  private storage: Buffer | undefined;
  private readOffset = 0;
  private pendingBytes = 0;

  constructor(
    private readonly maxBytes = OPENAI_QUICKSILVER_MAX_PENDING_AUDIO_BYTES,
    private readonly sampleBytes: 1 | 2 = 2,
  ) {}

  get length(): number {
    return this.pendingBytes;
  }

  append(incoming: Buffer): void {
    const alignedLength = incoming.length - (incoming.length % this.sampleBytes);
    if (alignedLength === 0) {
      return;
    }

    // Capture owns its input only until the next callback; copy each retained sample
    // once into the circular tail instead of copying the entire history per frame.
    const retainedBytes = Math.min(alignedLength, this.maxBytes);
    const sourceOffset = alignedLength - retainedBytes;
    const storage = (this.storage ??= Buffer.alloc(this.maxBytes));
    const droppedBytes = Math.max(0, this.pendingBytes + retainedBytes - this.maxBytes);
    this.readOffset = (this.readOffset + droppedBytes) % this.maxBytes;
    this.pendingBytes -= droppedBytes;

    const writeOffset = (this.readOffset + this.pendingBytes) % this.maxBytes;
    const firstBytes = Math.min(retainedBytes, this.maxBytes - writeOffset);
    incoming.copy(storage, writeOffset, sourceOffset, sourceOffset + firstBytes);
    if (firstBytes < retainedBytes) {
      incoming.copy(storage, 0, sourceOffset + firstBytes, sourceOffset + retainedBytes);
    }
    this.pendingBytes += retainedBytes;
  }

  readInto(target: Buffer): number {
    const alignedLength = target.length - (target.length % this.sampleBytes);
    const readBytes = Math.min(alignedLength, this.pendingBytes);
    const storage = this.storage;
    if (readBytes === 0 || !storage) {
      return 0;
    }

    const firstBytes = Math.min(readBytes, this.maxBytes - this.readOffset);
    storage.copy(target, 0, this.readOffset, this.readOffset + firstBytes);
    if (firstBytes < readBytes) {
      storage.copy(target, firstBytes, 0, readBytes - firstBytes);
    }
    this.readOffset = (this.readOffset + readBytes) % this.maxBytes;
    this.pendingBytes -= readBytes;
    if (this.pendingBytes === 0) {
      this.readOffset = 0;
    }
    return readBytes;
  }

  clear(): void {
    this.storage = undefined;
    this.readOffset = 0;
    this.pendingBytes = 0;
  }
}
