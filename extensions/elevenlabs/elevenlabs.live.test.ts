// Elevenlabs tests cover elevenlabs plugin behavior.
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  normalizeTranscriptForMatch,
  runRealtimeSttLiveTest,
  synthesizeElevenLabsLiveSpeech,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY ?? "";
const LIVE = isLiveTestEnabled(["ELEVENLABS_LIVE_TEST"]);
const describeLive = LIVE && ELEVENLABS_KEY ? describe : describe.skip;

const registerElevenLabsPlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "elevenlabs",
    name: "ElevenLabs Speech",
  });

describeLive("elevenlabs plugin live", () => {
  it("finalizes finite PCM input through the generic session contract", async () => {
    const { realtimeTranscriptionProviders } = await registerElevenLabsPlugin();
    const provider = requireRegisteredProvider(realtimeTranscriptionProviders, "elevenlabs");
    const phrase =
      "The kitchen lights are on. This is a synthetic test of complete speech recognition. " +
      "Please retain the final words of this recording. The final word is starlight.";
    const audio = await synthesizeElevenLabsLiveSpeech({
      text: phrase,
      apiKey: ELEVENLABS_KEY,
      outputFormat: "pcm_16000",
      timeoutMs: 30_000,
    });
    const controller = new AbortController();
    const errors: Error[] = [];
    const session = provider.createSession({
      providerConfig: { apiKey: ELEVENLABS_KEY, modelId: "scribe_v2_realtime", languageCode: "en" },
      utterance: {
        format: { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
        signal: controller.signal,
      },
      onError: (error) => errors.push(error),
    });
    const started = performance.now();
    try {
      if (!session.finishInput) {
        throw new Error("Provider did not expose finite-input completion");
      }
      await session.connect();
      for (let offset = 0; offset < audio.length; offset += 16000) {
        await session.writeAudio!(audio.subarray(offset, offset + 16000));
      }
      const finishedInput = performance.now();
      const result = await session.finishInput();
      expect(normalizeTranscriptForMatch(result.text)).toContain("starlight");
      expect(errors).toHaveLength(0);
      console.info(
        "FINITE_STT_RESULT",
        JSON.stringify({
          audioBytes: audio.length,
          audioSeconds: audio.length / 32000,
          elapsedMs: Math.round(performance.now() - started),
          afterInputMs: Math.round(performance.now() - finishedInput),
          transcript: result.text,
        }),
      );
    } finally {
      controller.abort();
      session.close();
    }
  }, 90_000);

  it("synthesizes speech through the registered provider with eleven_v3", async () => {
    const { speechProviders } = await registerElevenLabsPlugin();
    const provider = requireRegisteredProvider(speechProviders, "elevenlabs");

    const audioFile = await provider.synthesize({
      text: "OpenClaw ElevenLabs eleven v three text to speech integration test OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig: { apiKey: ELEVENLABS_KEY, modelId: "eleven_v3" },
      target: "audio-file",
      timeoutMs: 45_000,
    });

    expect(audioFile.outputFormat).toBe("mp3_44100_128");
    expect(audioFile.fileExtension).toBe(".mp3");
    expect(audioFile.audioBuffer.byteLength).toBeGreaterThan(512);
  }, 60_000);

  it("transcribes synthesized speech through the media provider", async () => {
    const { mediaProviders } = await registerElevenLabsPlugin();
    const provider = requireRegisteredProvider(mediaProviders, "elevenlabs");
    const phrase = "Testing OpenClaw ElevenLabs speech to text integration OK.";
    const audio = await synthesizeElevenLabsLiveSpeech({
      text: phrase,
      apiKey: ELEVENLABS_KEY,
      outputFormat: "mp3_44100_128",
      timeoutMs: 30_000,
    });

    const transcript = await provider.transcribeAudio?.({
      buffer: audio,
      fileName: "elevenlabs-live.mp3",
      mime: "audio/mpeg",
      apiKey: ELEVENLABS_KEY,
      timeoutMs: 60_000,
    });

    const normalized = normalizeTranscriptForMatch(transcript?.text ?? "");
    expect(normalized).toContain("openclaw");
    expect(normalized).toMatch(/(?:elevenlabs|11labs)/);
  }, 90_000);

  it("streams realtime STT through the registered transcription provider", async () => {
    const { realtimeTranscriptionProviders } = await registerElevenLabsPlugin();
    const provider = requireRegisteredProvider(realtimeTranscriptionProviders, "elevenlabs");
    const phrase = "Testing OpenClaw ElevenLabs realtime transcription integration OK.";
    const speech = await synthesizeElevenLabsLiveSpeech({
      text: phrase,
      apiKey: ELEVENLABS_KEY,
      outputFormat: "ulaw_8000",
      timeoutMs: 30_000,
    });
    expect(speech.byteLength).toBeGreaterThan(0);

    await runRealtimeSttLiveTest({
      provider,
      providerConfig: {
        apiKey: ELEVENLABS_KEY,
        audioFormat: "ulaw_8000",
        sampleRate: 8000,
        commitStrategy: "vad",
        languageCode: "en",
      },
      audio: Buffer.concat([Buffer.alloc(4000, 0xff), speech, Buffer.alloc(8000, 0xff)]),
      closeBeforeWait: true,
    });
  }, 90_000);
});
