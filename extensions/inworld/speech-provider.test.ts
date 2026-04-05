import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { buildInworldSpeechProvider } from "./speech-provider.js";

const provider = buildInworldSpeechProvider();

const BASE_CONFIG = {
  apiKey: "test-api-key",
  baseUrl: "https://api.inworld.ai",
  modelId: "inworld-tts-1.5-max",
  voiceId: "Ashley",
};

describe("buildInworldSpeechProvider", () => {
  describe("provider metadata", () => {
    it("has correct id and label", () => {
      expect(provider.id).toBe("inworld");
      expect(provider.label).toBe("Inworld");
    });

    it("has autoSelectOrder 50", () => {
      expect(provider.autoSelectOrder).toBe(50);
    });
  });

  describe("resolveConfig", () => {
    it("returns undefined modelId and voiceId when not set", () => {
      const config = provider.resolveConfig!({ rawConfig: {} });
      expect(config.modelId).toBeUndefined();
      expect(config.voiceId).toBeUndefined();
    });

    it("reads from providers.inworld path", () => {
      const config = provider.resolveConfig!({
        rawConfig: {
          providers: {
            inworld: { modelId: "inworld-tts-1.5-mini", voiceId: "Michael" },
          },
        },
      });
      expect(config.modelId).toBe("inworld-tts-1.5-mini");
      expect(config.voiceId).toBe("Michael");
    });

    it("defaults baseUrl", () => {
      const config = provider.resolveConfig!({ rawConfig: {} });
      expect(config.baseUrl).toBe("https://api.inworld.ai");
    });
  });

  describe("isConfigured", () => {
    it("returns false when apiKey missing", () => {
      expect(
        provider.isConfigured({ providerConfig: { ...BASE_CONFIG, apiKey: undefined } }),
      ).toBe(false);
    });

    it("returns false when modelId missing", () => {
      expect(
        provider.isConfigured({ providerConfig: { ...BASE_CONFIG, modelId: undefined } }),
      ).toBe(false);
    });

    it("returns false when voiceId missing", () => {
      expect(
        provider.isConfigured({ providerConfig: { ...BASE_CONFIG, voiceId: undefined } }),
      ).toBe(false);
    });

    it("returns true when all three present", () => {
      expect(provider.isConfigured({ providerConfig: BASE_CONFIG })).toBe(true);
    });

    it("returns true when INWORLD_API_KEY env is set", () => {
      const original = process.env.INWORLD_API_KEY;
      process.env.INWORLD_API_KEY = "env-key";
      try {
        expect(
          provider.isConfigured({
            providerConfig: { ...BASE_CONFIG, apiKey: undefined },
          }),
        ).toBe(true);
      } finally {
        process.env.INWORLD_API_KEY = original;
      }
    });
  });

  describe("parseDirectiveToken", () => {
    const policy = {
      allowVoice: true,
      allowModelId: false,
      allowVoiceSettings: false,
      allowNormalization: false,
      allowSeed: false,
    };

    it("does not handle generic voiceid key (let earlier providers claim it)", () => {
      const result = provider.parseDirectiveToken!({
        key: "voiceid",
        value: "Michael",
        policy,
        providerConfig: BASE_CONFIG,
        currentOverrides: undefined,
      });
      expect(result.handled).toBe(false);
    });

    it("does not handle generic voice_id key (let earlier providers claim it)", () => {
      const result = provider.parseDirectiveToken!({
        key: "voice_id",
        value: "Michael",
        policy,
        providerConfig: BASE_CONFIG,
        currentOverrides: undefined,
      });
      expect(result.handled).toBe(false);
    });

    it("handles inworld_voice key", () => {
      const result = provider.parseDirectiveToken!({
        key: "inworld_voice",
        value: "Michael",
        policy,
        providerConfig: BASE_CONFIG,
        currentOverrides: undefined,
      });
      expect(result.handled).toBe(true);
      expect(result.overrides?.voiceId).toBe("Michael");
    });

    it("handles inworldvoice key", () => {
      const result = provider.parseDirectiveToken!({
        key: "inworldvoice",
        value: "Michael",
        policy,
        providerConfig: BASE_CONFIG,
        currentOverrides: undefined,
      });
      expect(result.handled).toBe(true);
      expect(result.overrides?.voiceId).toBe("Michael");
    });

    it("returns handled:true but no overrides when allowVoice is false", () => {
      const result = provider.parseDirectiveToken!({
        key: "inworld_voice",
        value: "Michael",
        policy: { ...policy, allowVoice: false },
        providerConfig: BASE_CONFIG,
        currentOverrides: undefined,
      });
      expect(result.handled).toBe(true);
      expect(result.overrides).toBeUndefined();
    });

    it("returns handled:false for unknown keys", () => {
      const result = provider.parseDirectiveToken!({
        key: "unknown",
        value: "something",
        policy,
        providerConfig: BASE_CONFIG,
        currentOverrides: undefined,
      });
      expect(result.handled).toBe(false);
    });
  });

  describe("synthesize", () => {
    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ audioContent: Buffer.from("fake-audio").toString("base64") }),
        }),
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("throws when apiKey missing", async () => {
      const original = process.env.INWORLD_API_KEY;
      delete process.env.INWORLD_API_KEY;
      try {
        await expect(
          provider.synthesize({
            text: "hello",
            providerConfig: { ...BASE_CONFIG, apiKey: undefined },
            providerOverrides: undefined,
            target: "audio-file",
            timeoutMs: 10000,
          }),
        ).rejects.toThrow("Inworld API key missing");
      } finally {
        if (original !== undefined) {
          process.env.INWORLD_API_KEY = original;
        }
      }
    });

    it("throws when modelId missing", async () => {
      await expect(
        provider.synthesize({
          text: "hello",
          providerConfig: { ...BASE_CONFIG, modelId: undefined },
          providerOverrides: undefined,
          target: "audio-file",
          timeoutMs: 10000,
        }),
      ).rejects.toThrow("modelId missing");
    });

    it("throws when voiceId missing", async () => {
      await expect(
        provider.synthesize({
          text: "hello",
          providerConfig: { ...BASE_CONFIG, voiceId: undefined },
          providerOverrides: undefined,
          target: "audio-file",
          timeoutMs: 10000,
        }),
      ).rejects.toThrow("voiceId missing");
    });

    it("calls fetch with correct params", async () => {
      await provider.synthesize({
        text: "hello world",
        providerConfig: BASE_CONFIG,
        providerOverrides: undefined,
        target: "audio-file",
        timeoutMs: 10000,
      });

      expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.inworld.ai/tts/v1/voice");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["Authorization"]).toBe(
        "Basic test-api-key",
      );
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        text: "hello world",
        voiceId: "Ashley",
        modelId: "inworld-tts-1.5-max",
      });
    });

    it("applies voiceId override", async () => {
      await provider.synthesize({
        text: "hello",
        providerConfig: BASE_CONFIG,
        providerOverrides: { voiceId: "Michael" },
        target: "audio-file",
        timeoutMs: 10000,
      });

      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.voiceId).toBe("Michael");
    });

    it("returns Buffer with mp3 metadata", async () => {
      const result = await provider.synthesize({
        text: "hello",
        providerConfig: BASE_CONFIG,
        providerOverrides: undefined,
        target: "audio-file",
        timeoutMs: 10000,
      });

      expect(result.audioBuffer).toBeInstanceOf(Buffer);
      expect(result.outputFormat).toBe("mp3");
      expect(result.fileExtension).toBe(".mp3");
      expect(result.voiceCompatible).toBe(false);
    });
  });
});
