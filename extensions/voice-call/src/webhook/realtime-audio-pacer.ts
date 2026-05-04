import { mulawToPcm } from "openclaw/plugin-sdk/realtime-voice";

const TELEPHONY_SAMPLE_RATE = 8_000;
const TELEPHONY_CHUNK_BYTES = 160;
const TELEPHONY_CHUNK_MS = 20;
const DEFAULT_SPEECH_RMS_THRESHOLD = 0.02;
const DEFAULT_REQUIRED_LOUD_CHUNKS = 2;
const DEFAULT_REQUIRED_QUIET_CHUNKS = 10;

type RealtimeTwilioAudioQueueItem =
  | {
      chunk: Buffer;
      durationMs: number;
      type: "audio";
    }
  | {
      name: string;
      type: "mark";
    };

export type RealtimeTwilioAudioPacerSendJson = (message: unknown) => boolean;

export class RealtimeTwilioAudioPacer {
  private queue: RealtimeTwilioAudioQueueItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly params: {
      sendJson: RealtimeTwilioAudioPacerSendJson;
      streamSid: string;
    },
  ) {}

  sendAudio(muLaw: Buffer): void {
    if (this.closed || muLaw.length === 0) {
      return;
    }
    for (let offset = 0; offset < muLaw.length; offset += TELEPHONY_CHUNK_BYTES) {
      const chunk = Buffer.from(muLaw.subarray(offset, offset + TELEPHONY_CHUNK_BYTES));
      this.queue.push({
        type: "audio",
        chunk,
        durationMs: Math.max(1, Math.round((chunk.length / TELEPHONY_SAMPLE_RATE) * 1000)),
      });
    }
    this.ensurePump();
  }

  sendMark(name: string): void {
    if (this.closed || !name) {
      return;
    }
    this.queue.push({ type: "mark", name });
    this.ensurePump();
  }

  clearAudio(): void {
    if (this.closed) {
      return;
    }
    this.clearTimer();
    this.queue = [];
    this.params.sendJson({ event: "clear", streamSid: this.params.streamSid });
  }

  close(): void {
    this.closed = true;
    this.clearTimer();
    this.queue = [];
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
    let sent = true;
    if (item.type === "audio") {
      sent = this.params.sendJson({
        event: "media",
        streamSid: this.params.streamSid,
        media: { payload: item.chunk.toString("base64") },
      });
      delayMs = item.durationMs || TELEPHONY_CHUNK_MS;
    } else {
      sent = this.params.sendJson({
        event: "mark",
        streamSid: this.params.streamSid,
        mark: { name: item.name },
      });
    }

    if (!sent) {
      this.queue = [];
      return;
    }
    if (this.queue.length > 0) {
      this.timer = setTimeout(() => this.pump(), delayMs);
    }
  }
}

export function calculateMulawRms(muLaw: Buffer): number {
  if (muLaw.length === 0) {
    return 0;
  }
  const pcm = mulawToPcm(muLaw);
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const normalized = pcm.readInt16LE(i * 2) / 32768;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / samples);
}

export class RealtimeMulawSpeechStartDetector {
  private loudChunks = 0;
  private quietChunks = DEFAULT_REQUIRED_QUIET_CHUNKS;
  private speaking = false;

  constructor(
    private readonly params: {
      requiredLoudChunks?: number;
      requiredQuietChunks?: number;
      rmsThreshold?: number;
    } = {},
  ) {}

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
      this.speaking = false;
    }
    return false;
  }
}
