import type { Session } from "@google/genai";
import type { RealtimeVoiceAudioFormat } from "openclaw/plugin-sdk/realtime-voice";
import {
  createStreamingPcmResampler,
  mulawToPcm,
} from "openclaw/plugin-sdk/realtime-voice-provider";

export const GOOGLE_REALTIME_INPUT_SAMPLE_RATE = 16_000;

const MULAW_LINEAR_SAMPLES = new Int16Array(256);
const mulawTablePcm = mulawToPcm(Buffer.from(Array.from({ length: 256 }, (_, index) => index)));

for (let i = 0; i < MULAW_LINEAR_SAMPLES.length; i += 1) {
  MULAW_LINEAR_SAMPLES[i] = mulawTablePcm.readInt16LE(i * 2);
}

export class GoogleLiveInputAudio {
  private resampler?: ReturnType<typeof createStreamingPcmResampler>;

  constructor(private readonly format: RealtimeVoiceAudioFormat) {}

  send(session: Session, audio: Buffer): void {
    if (this.format.encoding === "g711_ulaw") {
      sendGoogleInputPcm(session, convertMulaw8kToPcm16k(audio));
      return;
    }
    this.resampler ??= createStreamingPcmResampler(
      this.format.sampleRateHz,
      GOOGLE_REALTIME_INPUT_SAMPLE_RATE,
    );
    const pcm = this.resampler.process(audio);
    if (pcm.length > 0) {
      sendGoogleInputPcm(session, pcm);
    }
  }

  flush(session: Session): void {
    const tail = this.resampler?.flush();
    this.reset();
    if (tail?.length) {
      sendGoogleInputPcm(session, tail);
    }
  }

  reset(): void {
    this.resampler = undefined;
  }
}

function sendGoogleInputPcm(session: Session, pcm: Buffer): void {
  session.sendRealtimeInput({
    audio: {
      data: pcm.toString("base64"),
      mimeType: `audio/pcm;rate=${GOOGLE_REALTIME_INPUT_SAMPLE_RATE}`,
    },
  });
}

function convertMulaw8kToPcm16k(muLaw: Buffer): Buffer {
  if (muLaw.length === 0) {
    return Buffer.alloc(0);
  }
  const pcm = Buffer.alloc(muLaw.length * 4);
  for (let i = 0; i < muLaw.length; i += 1) {
    const current = MULAW_LINEAR_SAMPLES[muLaw[i] ?? 0] ?? 0;
    const next = MULAW_LINEAR_SAMPLES[muLaw[i + 1] ?? muLaw[i] ?? 0] ?? current;
    pcm.writeInt16LE(current, i * 4);
    pcm.writeInt16LE(Math.round((current + next) / 2), i * 4 + 2);
  }
  return pcm;
}
