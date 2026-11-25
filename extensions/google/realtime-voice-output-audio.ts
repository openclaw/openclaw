import { randomUUID } from "node:crypto";
import type {
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBridgeCreateRequest,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  createStreamingPcmResampler,
  pcmToMulaw,
} from "openclaw/plugin-sdk/realtime-voice-provider";

function parsePcmSampleRate(mimeType: string | undefined): number {
  const match = mimeType?.match(/(?:^|[;,\s])rate=(\d+)/i);
  const parsed = match ? Number.parseInt(match[1] ?? "", 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24_000;
}

export class GoogleLiveOutputAudio {
  private stream?: {
    sampleRate: number;
    resampler: ReturnType<typeof createStreamingPcmResampler>;
  };

  constructor(
    private readonly format: RealtimeVoiceAudioFormat,
    private readonly callbacks: Pick<RealtimeVoiceBridgeCreateRequest, "onAudio" | "onMark">,
  ) {}

  play(pcm: Buffer, mimeType: string | undefined): void {
    const sampleRate = parsePcmSampleRate(mimeType);
    if (this.stream && this.stream.sampleRate !== sampleRate) {
      this.flush();
    }
    if (sampleRate === this.format.sampleRateHz) {
      this.emit(pcm);
      return;
    }
    this.stream ??= {
      sampleRate,
      resampler: createStreamingPcmResampler(sampleRate, this.format.sampleRateHz),
    };
    this.emit(this.stream.resampler.process(pcm));
  }

  flush(): void {
    const stream = this.stream;
    this.reset();
    if (stream) {
      this.emit(stream.resampler.flush());
    }
  }

  reset(): void {
    this.stream = undefined;
  }

  private emit(pcm: Buffer): void {
    const audio = this.format.encoding === "pcm16" ? pcm : pcmToMulaw(pcm);
    if (audio.length > 0) {
      this.callbacks.onAudio(audio);
      this.callbacks.onMark?.(`audio-${randomUUID()}`);
    }
  }
}
