import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInworldSpeechProvider } from "./speech-provider.js";

describe("buildInworldSpeechProvider", () => {
  const originalEnv = process.env.INWORLD_API_KEY;

  afterEach(() => {
    process.env.INWORLD_API_KEY = originalEnv;
    vi.restoreAllMocks();
  });

  it("reports configured when INWORLD_API_KEY env var is set", () => {
    process.env.INWORLD_API_KEY = "test-key";
    const provider = buildInworldSpeechProvider();
    expect(
      provider.isConfigured({
        providerConfig: {},
        timeoutMs: 30_000,
      }),
    ).toBe(true);
  });

  it("reports configured when providerConfig apiKey is set", () => {
    delete process.env.INWORLD_API_KEY;
    const provider = buildInworldSpeechProvider();
    expect(
      provider.isConfigured({
        providerConfig: { apiKey: "config-key" },
        timeoutMs: 30_000,
      }),
    ).toBe(true);
  });

  it("reports not configured when no key is available", () => {
    delete process.env.INWORLD_API_KEY;
    const provider = buildInworldSpeechProvider();
    expect(
      provider.isConfigured({
        providerConfig: {},
        timeoutMs: 30_000,
      }),
    ).toBe(false);
  });

  it("has correct provider metadata", () => {
    const provider = buildInworldSpeechProvider();
    expect(provider.id).toBe("inworld");
    expect(provider.label).toBe("Inworld");
    expect(provider.autoSelectOrder).toBe(30);
    expect(provider.models).toContain("inworld-tts-1.5-max");
    expect(provider.models).toContain("inworld-tts-1.5-mini");
  });

  it("normalizes provider-owned speech config from raw provider config", () => {
    const provider = buildInworldSpeechProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      timeoutMs: 30_000,
      rawConfig: {
        providers: {
          inworld: {
            apiKey: "basic-key",
            baseUrl: "https://custom.inworld.example.com/",
            voiceId: "Ashley",
            modelId: "inworld-tts-1.5-mini",
            temperature: 0.8,
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "basic-key",
      baseUrl: "https://custom.inworld.example.com",
      voiceId: "Ashley",
      modelId: "inworld-tts-1.5-mini",
      temperature: 0.8,
    });
  });
});
