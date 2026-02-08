import { describe, expect, it, vi } from "vitest";
import type { CambClientWrapper } from "../client.js";
import type { CambAiConfig } from "../config.js";
import { createTtsTool } from "./tts.js";

function createConfig(overrides: Partial<CambAiConfig> = {}): CambAiConfig {
  return {
    enabled: true,
    apiKey: "test-api-key",
    tts: {
      model: "mars-flash",
      defaultLanguage: "en-us",
      defaultVoiceId: 123,
      outputFormat: "mp3",
    },
    voiceCloning: { enabled: false },
    soundGeneration: { enabled: false },
    pollingIntervalMs: 2000,
    pollingTimeoutMs: 120000,
    ...overrides,
  };
}

function createMockClientWrapper(ttsResponse?: unknown): CambClientWrapper {
  // BinaryResponse has arrayBuffer() method that returns the audio data
  const mockResponse = ttsResponse ?? {
    arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([72, 101, 108, 108, 111]).buffer), // "Hello" bytes
  };

  return {
    getClient: vi.fn().mockReturnValue({
      textToSpeech: {
        tts: vi.fn().mockResolvedValue(mockResponse),
      },
    }),
  } as unknown as CambClientWrapper;
}

describe("camb_tts tool", () => {
  it("has correct tool metadata", () => {
    const wrapper = createMockClientWrapper();
    const config = createConfig();
    const tool = createTtsTool(wrapper, config);

    expect(tool.name).toBe("camb_tts");
    expect(tool.label).toBe("Camb AI TTS");
    expect(tool.description).toContain("Convert text to speech");
  });

  describe("execute", () => {
    it("returns error when text is missing", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig();
      const tool = createTtsTool(wrapper, config);

      const result = await tool.execute("call-1", {});
      const details = (result as any).details;

      expect(details.error).toBe("text is required");
    });

    it("returns error when text is empty string", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig();
      const tool = createTtsTool(wrapper, config);

      const result = await tool.execute("call-1", { text: "   " });
      const details = (result as any).details;

      expect(details.error).toBe("text is required");
    });

    it("returns error when voice_id is not provided and no default", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig({ tts: { ...createConfig().tts, defaultVoiceId: undefined } });
      const tool = createTtsTool(wrapper, config);

      const result = await tool.execute("call-1", { text: "Hello world" });
      const details = (result as any).details;

      expect(details.error).toContain("voice_id is required");
    });

    it("generates audio successfully with all parameters", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig();
      const tool = createTtsTool(wrapper, config);

      const result = await tool.execute("call-1", {
        text: "Hello world",
        voice_id: 456,
        language: "es-es",
        model: "mars-pro",
      });
      const details = (result as any).details;

      expect(details.success).toBe(true);
      expect(details.format).toBe("mp3");
      expect(details.language).toBe("es-es");
      expect(details.voice_id).toBe(456);
      expect(details.model).toBe("mars-pro");
      expect(details.text_length).toBe(11);
      expect(details.audio_size_bytes).toBeGreaterThan(0);
      expect(details.audio_base64).toBeDefined();
    });

    it("uses default voice_id from config", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig({ tts: { ...createConfig().tts, defaultVoiceId: 789 } });
      const tool = createTtsTool(wrapper, config);

      const result = await tool.execute("call-1", { text: "Hello" });
      const details = (result as any).details;

      expect(details.success).toBe(true);
      expect(details.voice_id).toBe(789);
    });

    it("uses default language from config", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig({ tts: { ...createConfig().tts, defaultLanguage: "fr-fr" } });
      const tool = createTtsTool(wrapper, config);

      const result = await tool.execute("call-1", { text: "Hello", voice_id: 123 });
      const details = (result as any).details;

      expect(details.success).toBe(true);
      expect(details.language).toBe("fr-fr");
    });

    it("uses default model from config", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig({ tts: { ...createConfig().tts, model: "mars-instruct" } });
      const tool = createTtsTool(wrapper, config);

      const result = await tool.execute("call-1", { text: "Hello", voice_id: 123 });
      const details = (result as any).details;

      expect(details.success).toBe(true);
      expect(details.model).toBe("mars-instruct");
    });

    it("passes instructions to API when provided", async () => {
      const ttsMock = vi.fn().mockResolvedValue({
        arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
      });
      const wrapper = {
        getClient: vi.fn().mockReturnValue({
          textToSpeech: { tts: ttsMock },
        }),
      } as unknown as CambClientWrapper;
      const config = createConfig();
      const tool = createTtsTool(wrapper, config);

      await tool.execute("call-1", {
        text: "Hello",
        voice_id: 123,
        instructions: "Speak slowly and clearly",
      });

      expect(ttsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          user_instructions: "Speak slowly and clearly",
        }),
      );
    });

    it("handles API errors gracefully", async () => {
      const wrapper = {
        getClient: vi.fn().mockReturnValue({
          textToSpeech: {
            tts: vi.fn().mockRejectedValue(new Error("API rate limit exceeded")),
          },
        }),
      } as unknown as CambClientWrapper;
      const config = createConfig();
      const tool = createTtsTool(wrapper, config);

      const result = await tool.execute("call-1", { text: "Hello", voice_id: 123 });
      const details = (result as any).details;

      expect(details.error).toBe("API rate limit exceeded");
    });

    it("returns base64 encoded audio", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig();
      const tool = createTtsTool(wrapper, config);

      const result = await tool.execute("call-1", { text: "Hello", voice_id: 123 });
      const details = (result as any).details;

      expect(details.audio_base64).toBe(Buffer.from("Hello").toString("base64"));
    });
  });
});
