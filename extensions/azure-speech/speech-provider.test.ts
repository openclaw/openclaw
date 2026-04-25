import { describe, expect, it } from "vitest";
import { buildAzureSpeechProviderPlugin } from "./speech-provider.js";

describe("azure-speech speech provider", () => {
  const provider = buildAzureSpeechProviderPlugin();

  it("has correct id and label", () => {
    expect(provider.id).toBe("azure-speech");
    expect(provider.label).toBe("Azure Speech");
    expect(provider.aliases).toContain("azure");
    expect(provider.aliases).toContain("azure-tts");
  });

  it("isConfigured returns true only when both apiKey and voice present", async () => {
    // No config - should not be configured
    expect(provider.isConfigured!({ providerConfig: {} })).toBe(false);

    // API key only - should not be configured
    expect(provider.isConfigured!({ providerConfig: { apiKey: "test-key" } })).toBe(false);

    // Voice only - should not be configured
    expect(provider.isConfigured!({ providerConfig: { voice: "en-US-JennyNeural" } })).toBe(false);

    // Both - should be configured
    expect(provider.isConfigured!({ providerConfig: { apiKey: "test-key", voice: "en-US-JennyNeural" } })).toBe(true);
  });

  it("resolveProviderConfig extracts correct fields", () => {
    const params = {
      voiceId: "zh-HK-HiuMaanNeural",
      outputFormat: "audio-24khz-48kbitrate-mono-mp3",
      lang: "zh-HK",
      region: "eastus",
      baseUrl: "https://custom.tts.speech.microsoft.com",
    };
    const config = provider.resolveProviderConfig!({ params, config: {} as any });
    expect(config.voice).toBe("zh-HK-HiuMaanNeural");
    expect(config.outputFormat).toBe("audio-24khz-48kbitrate-mono-mp3");
    expect(config.lang).toBe("zh-HK");
    expect(config.region).toBe("eastus");
    expect(config.baseUrl).toBe("https://custom.tts.speech.microsoft.com");
  });

  it("resolveProviderOverrides extracts voice and outputFormat", () => {
    const params = { voiceId: "zh-HK-HiuGaaiNeural", outputFormat: "riff-16khz-16bit-mono-pcm" };
    const overrides = provider.resolveProviderOverrides!({ params, config: {} as any });
    expect(overrides).toEqual({ voice: "zh-HK-HiuGaaiNeural", outputFormat: "riff-16khz-16bit-mono-pcm" });
  });

  it("resolveProviderOverrides returns undefined when no overrides", () => {
    const overrides = provider.resolveProviderOverrides!({ params: {}, config: {} as any });
    expect(overrides).toBeUndefined();
  });
});