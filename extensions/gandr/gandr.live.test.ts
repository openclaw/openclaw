// Gandr tests cover gandr plugin behavior against the live API.
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { GANDR_MAX_INPUT_CHARS, GANDR_PCM_SAMPLE_RATE_HERTZ } from "./tts.js";

const GANDR_API_KEY = process.env.GANDR_API_KEY?.trim() ?? "";
const LIVE = isLiveTestEnabled() && GANDR_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

const registerGandrPlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "gandr",
    name: "Gandr Speech",
  });

describeLive("gandr plugin live", () => {
  it("lists voices through the registered speech provider", async () => {
    const { speechProviders } = await registerGandrPlugin();
    const provider = requireRegisteredProvider(speechProviders, "gandr");

    const voices = await provider.listVoices?.({ apiKey: GANDR_API_KEY });

    expect(voices?.length).toBe(6);
    expect(voices?.some((voice) => voice.id === "gandr-mia")).toBe(true);
  }, 120_000);

  it("synthesizes MP3 for attachments and raw PCM for telephony", async () => {
    const { speechProviders } = await registerGandrPlugin();
    const provider = requireRegisteredProvider(speechProviders, "gandr");
    const providerConfig = {
      apiKey: GANDR_API_KEY,
      voiceId: "gandr-mia",
      modelId: "tts-1",
    };

    const audioFile = await provider.synthesize({
      text: "OpenClaw Gandr text to speech integration test OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig,
      target: "audio-file",
      timeoutMs: 90_000,
    });

    expect(audioFile.outputFormat).toBe("mp3");
    expect(audioFile.fileExtension).toBe(".mp3");
    // Gandr MP3 is not a channel-native voice note; the pipeline transcodes.
    expect(audioFile.voiceCompatible).toBe(false);
    expect(audioFile.audioBuffer.byteLength).toBeGreaterThan(512);
    expect(audioFile.audioBuffer.subarray(0, 4).toString("ascii")).not.toBe("RIFF");
    // MPEG frame sync, so the bytes really are MP3 rather than an error page.
    expect(audioFile.audioBuffer.subarray(0, 2).toString("hex")).toMatch(/^ff[ef]/);

    const telephony = await provider.synthesizeTelephony?.({
      text: "OpenClaw Gandr telephony check OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig,
      timeoutMs: 90_000,
    });
    if (!telephony) {
      throw new Error("Gandr telephony synthesis did not return audio");
    }
    expect(telephony.outputFormat).toBe("pcm");
    expect(telephony.sampleRate).toBe(GANDR_PCM_SAMPLE_RATE_HERTZ);
    expect(telephony.audioBuffer.byteLength).toBeGreaterThan(512);
    // Headerless signed 16-bit little-endian mono: no container magic, even length.
    expect(telephony.audioBuffer.subarray(0, 4).toString("ascii")).not.toBe("RIFF");
    expect(telephony.audioBuffer.subarray(0, 4).toString("ascii")).not.toBe("OggS");
    expect(telephony.audioBuffer.byteLength % 2).toBe(0);

    // Live suites print progress; these lines are the observed evidence.
    const pcmSeconds = telephony.audioBuffer.byteLength / 2 / telephony.sampleRate;
    console.log(
      `[gandr live] attachment: ${audioFile.outputFormat} ${audioFile.audioBuffer.byteLength} bytes, ` +
        `frame sync 0x${audioFile.audioBuffer.subarray(0, 2).toString("hex")}`,
    );
    console.log(
      `[gandr live] telephony: ${telephony.outputFormat} ${telephony.audioBuffer.byteLength} bytes ` +
        `at ${telephony.sampleRate} Hz = ${pcmSeconds.toFixed(2)}s mono 16-bit`,
    );
  }, 180_000);

  it("rejects over-cap input before any request reaches the API", async () => {
    const { speechProviders } = await registerGandrPlugin();
    const provider = requireRegisteredProvider(speechProviders, "gandr");

    expect(() =>
      provider.prepareSynthesis?.({
        text: "a".repeat(GANDR_MAX_INPUT_CHARS + 1),
        cfg: { plugins: { enabled: true } } as never,
        providerConfig: { apiKey: GANDR_API_KEY },
        target: "audio-file",
        timeoutMs: 30_000,
      }),
    ).toThrow(/Gandr TTS input too long/);
  }, 60_000);
});
