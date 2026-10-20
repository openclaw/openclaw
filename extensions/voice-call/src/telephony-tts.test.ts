import { describe, expect, it, vi } from "vitest";
import { createTelephonyTtsProvider, type TelephonyTtsRuntime } from "./telephony-tts.js";

const passthroughPreparation: TelephonyTtsRuntime["prepareTtsRequest"] = async ({ cfg, text }) => ({
  cfg,
  directives: { cleanedText: text, hasDirective: false, overrides: {}, warnings: [] },
});

function createProvider(
  textToSpeechTelephony: TelephonyTtsRuntime["textToSpeechTelephony"],
  prepareTtsRequest: TelephonyTtsRuntime["prepareTtsRequest"] = passthroughPreparation,
  logger?: Parameters<typeof createTelephonyTtsProvider>[0]["logger"],
) {
  return createTelephonyTtsProvider({
    coreConfig: {},
    runtime: { prepareTtsRequest, textToSpeechTelephony },
    logger,
  });
}

const audioResult = { success: true, audioBuffer: Buffer.alloc(2), sampleRate: 8000 };
const createSynthesis = () => vi.fn(async () => audioResult);

describe("createTelephonyTtsProvider", () => {
  it("passes through Gradium 8 kHz mu-law output", async () => {
    const audioBuffer = Buffer.from([0x00, 0x7f, 0xff]);
    const provider = await createProvider(async () => ({
      ...audioResult,
      audioBuffer,
      outputFormat: "ulaw_8000",
      provider: "gradium",
    }));
    await expect(provider.synthesizeForTelephony("hello")).resolves.toBe(audioBuffer);
  });

  it("rejects container output with provider context", async () => {
    const outputFormat = "riff-8khz-8bit-mono-mulaw";
    const provider = await createProvider(async () => ({
      ...audioResult,
      audioBuffer: Buffer.from("container"),
      outputFormat,
      provider: "example-provider",
    }));

    const synthesis = provider.synthesizeForTelephony("hello");
    await expect(synthesis).rejects.toMatchObject({
      name: "UnsupportedTelephonyTtsOutputFormatError",
      message: `Unsupported telephony TTS output format "${outputFormat}" from provider "example-provider"`,
    });
  });

  it("logs fallback metadata when telephony TTS uses a fallback provider", async () => {
    const warn = vi.fn();
    const provider = await createProvider(
      async () => ({
        ...audioResult,
        provider: "microsoft",
        fallbackFrom: "elevenlabs",
        attemptedProviders: ["elevenlabs", "microsoft"],
      }),
      passthroughPreparation,
      { warn },
    );

    await provider.synthesizeForTelephony("hello");
    expect(warn).toHaveBeenCalledWith(
      "[voice-call] Telephony TTS fallback used from=elevenlabs to=microsoft attempts=elevenlabs -> microsoft",
    );
  });

  it.each([
    {
      name: "directive-stripped text",
      input: "[[tts]]Hello caller[[/tts]]",
      cleanedText: "Hello caller",
      ttsText: undefined,
      expected: { text: "Hello caller" },
    },
    {
      name: "hidden directive text and overrides",
      input: "Visible text [[tts:text]]Speak this instead[[/tts:text]]",
      cleanedText: "Visible text ",
      ttsText: "Speak this instead",
      expected: { text: "Speak this instead", overrides: { ttsText: "Speak this instead" } },
    },
  ])("uses prepared $name for synthesis", async ({ input, cleanedText, ttsText, expected }) => {
    const textToSpeechTelephony = createSynthesis();
    const provider = await createProvider(textToSpeechTelephony, async ({ cfg, text }) => ({
      cfg,
      directives: {
        cleanedText: text ? cleanedText : "",
        ttsText: text ? ttsText : undefined,
        hasDirective: text.length > 0,
        overrides: text && ttsText ? { ttsText } : {},
        warnings: [],
      },
    }));

    await provider.synthesizeForTelephony(input);
    expect(textToSpeechTelephony).toHaveBeenCalledWith(expect.objectContaining(expected));
  });
});
