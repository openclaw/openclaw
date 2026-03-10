import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { CoreConfig } from "./core-bridge.js";
import { createTelephonyTtsProvider } from "./telephony-tts.js";

function createCoreConfig(): CoreConfig {
  return {
    messages: {
      tts: {
        provider: "openai",
        openai: { model: "gpt-4o-mini-tts", voice: "alloy" },
      },
    },
  };
}

describe("createTelephonyTtsProvider streaming", () => {
  it("attaches synthesizeForTelephonyStream when runtime provides streaming", () => {
    const provider = createTelephonyTtsProvider({
      coreConfig: createCoreConfig(),
      runtime: {
        textToSpeechTelephony: async () => ({
          success: true,
          audioBuffer: Buffer.alloc(2),
          sampleRate: 8000,
        }),
        textToSpeechTelephonyStream: async () => ({
          success: true,
          stream: Readable.from(Buffer.alloc(10)),
          sampleRate: 24000,
          cleanup: () => {},
        }),
      },
    });

    expect(provider.synthesizeForTelephonyStream).toBeDefined();
    expect(typeof provider.synthesizeForTelephonyStream).toBe("function");
  });

  it("does not attach synthesizeForTelephonyStream when runtime lacks it", () => {
    const provider = createTelephonyTtsProvider({
      coreConfig: createCoreConfig(),
      runtime: {
        textToSpeechTelephony: async () => ({
          success: true,
          audioBuffer: Buffer.alloc(2),
          sampleRate: 8000,
        }),
      },
    });

    expect(provider.synthesizeForTelephonyStream).toBeUndefined();
  });

  it("streaming method returns stream, sampleRate, and cleanup", async () => {
    const cleanupCalled: boolean[] = [];
    const pcmData = Buffer.alloc(160);
    for (let i = 0; i < 80; i++) {
      pcmData.writeInt16LE(i * 100, i * 2);
    }

    const provider = createTelephonyTtsProvider({
      coreConfig: createCoreConfig(),
      runtime: {
        textToSpeechTelephony: async () => ({
          success: true,
          audioBuffer: Buffer.alloc(2),
          sampleRate: 8000,
        }),
        textToSpeechTelephonyStream: async () => ({
          success: true,
          stream: Readable.from(pcmData),
          sampleRate: 24000,
          cleanup: () => {
            cleanupCalled.push(true);
          },
        }),
      },
    });

    const result = await provider.synthesizeForTelephonyStream!("test");
    expect(result.stream).toBeDefined();
    expect(result.sampleRate).toBe(24000);
    expect(typeof result.cleanup).toBe("function");
  });

  it("streaming method throws when result indicates failure", async () => {
    const provider = createTelephonyTtsProvider({
      coreConfig: createCoreConfig(),
      runtime: {
        textToSpeechTelephony: async () => ({
          success: true,
          audioBuffer: Buffer.alloc(2),
          sampleRate: 8000,
        }),
        textToSpeechTelephonyStream: async () => ({
          success: false,
          error: "No OpenAI API key",
        }),
      },
    });

    await expect(provider.synthesizeForTelephonyStream!("test")).rejects.toThrow(
      "No OpenAI API key",
    );
  });

  it("buffered synthesizeForTelephony still works alongside streaming", async () => {
    const provider = createTelephonyTtsProvider({
      coreConfig: createCoreConfig(),
      runtime: {
        textToSpeechTelephony: async () => ({
          success: true,
          audioBuffer: Buffer.alloc(4),
          sampleRate: 8000,
        }),
        textToSpeechTelephonyStream: async () => ({
          success: true,
          stream: Readable.from(Buffer.alloc(10)),
          sampleRate: 24000,
          cleanup: () => {},
        }),
      },
    });

    const result = await provider.synthesizeForTelephony("test");
    // convertPcmToMulaw8k(4 bytes at 8kHz) = 2 samples -> 2 bytes mulaw
    expect(result.length).toBe(2);
  });
});
