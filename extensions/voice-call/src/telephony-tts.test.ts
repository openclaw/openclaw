import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Voice Call tests cover telephony tts plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { VoiceCallTtsConfig } from "./config.js";
import { createTelephonyTtsProvider, type TelephonyTtsRuntime } from "./telephony-tts.js";

function createCoreConfig(): OpenClawConfig {
  const tts: VoiceCallTtsConfig = {
    provider: "openai",
    providers: {
      openai: {
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
    },
  };
  return { tts };
}

const passthroughPreparation: TelephonyTtsRuntime["prepareTtsRequest"] = async ({ cfg, text }) => ({
  cfg,
  directives: {
    cleanedText: text,
    hasDirective: false,
    overrides: {},
    warnings: [],
  },
});

function createRuntime(
  textToSpeechTelephony: TelephonyTtsRuntime["textToSpeechTelephony"],
  prepareTtsRequest: TelephonyTtsRuntime["prepareTtsRequest"] = passthroughPreparation,
): TelephonyTtsRuntime {
  return { prepareTtsRequest, textToSpeechTelephony };
}

const createSynthesis = () =>
  vi.fn(async () => ({
    success: true,
    audioBuffer: Buffer.alloc(2),
    sampleRate: 8000,
  }));

describe("createTelephonyTtsProvider", () => {
  it.each([["Gradium", "ulaw_8000"]])(
    "passes through %s 8 kHz mu-law output",
    async (providerName, outputFormat) => {
      const audioBuffer = Buffer.from([0x00, 0x7f, 0xff]);
      const provider = await createTelephonyTtsProvider({
        coreConfig: createCoreConfig(),
        runtime: createRuntime(async () => ({
          success: true,
          audioBuffer,
          outputFormat,
          sampleRate: 8_000,
          provider: providerName.toLowerCase(),
        })),
      });

      await expect(provider.synthesizeForTelephony("hello")).resolves.toBe(audioBuffer);
    },
  );

  it("rejects container output with provider context", async () => {
    const outputFormat = "riff-8khz-8bit-mono-mulaw";
    const sampleRate = 8_000;
    const provider = await createTelephonyTtsProvider({
      coreConfig: createCoreConfig(),
      runtime: createRuntime(async () => ({
        success: true,
        audioBuffer: Buffer.from("container"),
        outputFormat,
        sampleRate,
        provider: "example-provider",
      })),
    });

    const synthesis = provider.synthesizeForTelephony("hello");
    await expect(synthesis).rejects.toMatchObject({
      name: "UnsupportedTelephonyTtsOutputFormatError",
      message: `Unsupported telephony TTS output format "${outputFormat}" from provider "example-provider"`,
    });
  });

  it("logs fallback metadata when telephony TTS uses a fallback provider", async () => {
    const warn = vi.fn();
    const provider = await createTelephonyTtsProvider({
      coreConfig: createCoreConfig(),
      runtime: createRuntime(async () => ({
        success: true,
        audioBuffer: Buffer.alloc(2),
        sampleRate: 8000,
        provider: "microsoft",
        fallbackFrom: "elevenlabs",
        attemptedProviders: ["elevenlabs", "microsoft"],
      })),
      logger: { warn },
    });

    await provider.synthesizeForTelephony("hello");
    expect(warn).toHaveBeenCalledWith(
      "[voice-call] Telephony TTS fallback used from=elevenlabs to=microsoft attempts=elevenlabs -> microsoft",
    );
  });

  it("uses prepared directive-stripped text for synthesis", async () => {
    const textToSpeechTelephony = createSynthesis();
    const provider = await createTelephonyTtsProvider({
      coreConfig: createCoreConfig(),
      runtime: createRuntime(textToSpeechTelephony, async ({ cfg, text }) => ({
        cfg,
        directives: {
          cleanedText: text ? "Hello caller" : "",
          hasDirective: text.length > 0,
          overrides: {},
          warnings: [],
        },
      })),
    });

    await provider.synthesizeForTelephony("[[tts]]Hello caller[[/tts]]");

    expect(textToSpeechTelephony).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hello caller" }),
    );
  });

  it("uses prepared hidden directive text and overrides for synthesis", async () => {
    const textToSpeechTelephony = createSynthesis();
    const provider = await createTelephonyTtsProvider({
      coreConfig: createCoreConfig(),
      runtime: createRuntime(textToSpeechTelephony, async ({ cfg, text }) => ({
        cfg,
        directives: {
          cleanedText: text ? "Visible text " : "",
          ttsText: text ? "Speak this instead" : undefined,
          hasDirective: text.length > 0,
          overrides: text ? { ttsText: "Speak this instead" } : {},
          warnings: [],
        },
      })),
    });

    await provider.synthesizeForTelephony(
      "Visible text [[tts:text]]Speak this instead[[/tts:text]]",
    );

    expect(textToSpeechTelephony).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Speak this instead",
        overrides: { ttsText: "Speak this instead" },
      }),
    );
  });
});
