import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { CambClientWrapper } from "../client.js";
import type { CambAiConfig } from "../config.js";
import { createVoiceCloneTool } from "./voice-clone.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

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
    voiceCloning: { enabled: true },
    soundGeneration: { enabled: false },
    pollingIntervalMs: 100,
    pollingTimeoutMs: 1000,
    ...overrides,
  };
}

function createMockClientWrapper(taskId = "clone-task-123"): CambClientWrapper {
  return {
    getClient: vi.fn().mockReturnValue({
      voiceCloning: {
        createCustomVoice: vi.fn().mockResolvedValue({ task_id: taskId }),
      },
    }),
  } as unknown as CambClientWrapper;
}

describe("camb_voice_clone tool", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      blob: vi.fn().mockResolvedValue(new Blob(["audio data"], { type: "audio/wav" })),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("has correct tool metadata", () => {
    const wrapper = createMockClientWrapper();
    const config = createConfig();
    const tool = createVoiceCloneTool(wrapper, config);

    expect(tool.name).toBe("camb_voice_clone");
    expect(tool.label).toBe("Camb AI Voice Clone");
    expect(tool.description).toContain("Clone a voice");
  });

  describe("execute", () => {
    it("returns error when voice cloning is disabled", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig({ voiceCloning: { enabled: false } });
      const tool = createVoiceCloneTool(wrapper, config);

      const result = await tool.execute("call-1", {
        audio_url: "https://example.com/voice.wav",
        voice_name: "Test Voice",
        gender: 1,
      });
      const details = (result as any).details;

      expect(details.error).toContain("Voice cloning is disabled");
    });

    it("returns error when audio_url is missing", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig();
      const tool = createVoiceCloneTool(wrapper, config);

      const result = await tool.execute("call-1", {
        voice_name: "Test Voice",
        gender: 1,
      });
      const details = (result as any).details;

      expect(details.error).toBe("audio_url is required");
    });

    it("returns error when voice_name is missing", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig();
      const tool = createVoiceCloneTool(wrapper, config);

      const result = await tool.execute("call-1", {
        audio_url: "https://example.com/voice.wav",
        gender: 1,
      });
      const details = (result as any).details;

      expect(details.error).toBe("voice_name is required");
    });

    it("returns error when gender is invalid", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig();
      const tool = createVoiceCloneTool(wrapper, config);

      const result = await tool.execute("call-1", {
        audio_url: "https://example.com/voice.wav",
        voice_name: "Test Voice",
        gender: 3,
      });
      const details = (result as any).details;

      expect(details.error).toBe("gender must be 1 (male) or 2 (female)");
    });

    it("returns error when gender is not a number", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig();
      const tool = createVoiceCloneTool(wrapper, config);

      const result = await tool.execute("call-1", {
        audio_url: "https://example.com/voice.wav",
        voice_name: "Test Voice",
        gender: "male",
      });
      const details = (result as any).details;

      expect(details.error).toBe("gender must be 1 (male) or 2 (female)");
    });

    it("clones voice successfully with all required params", async () => {
      const wrapper = createMockClientWrapper("task-xyz");
      const config = createConfig();
      const tool = createVoiceCloneTool(wrapper, config);

      const result = await tool.execute("call-1", {
        audio_url: "https://example.com/voice.wav",
        voice_name: "My Custom Voice",
        gender: 1,
      });
      const details = (result as any).details;

      expect(details.success).toBe(true);
      expect(details.task_id).toBe("task-xyz");
      expect(details.voice_name).toBe("My Custom Voice");
      expect(details.message).toContain("Voice cloning task started");
    });

    it("passes optional parameters to API", async () => {
      const createCustomVoiceMock = vi.fn().mockResolvedValue({ task_id: "clone-task-123" });
      const wrapper = {
        getClient: vi.fn().mockReturnValue({
          voiceCloning: { createCustomVoice: createCustomVoiceMock },
        }),
      } as unknown as CambClientWrapper;
      const config = createConfig();
      const tool = createVoiceCloneTool(wrapper, config);

      await tool.execute("call-1", {
        audio_url: "https://example.com/voice.wav",
        voice_name: "Test Voice",
        gender: 2,
        description: "A warm female voice",
        language: 47,
        enhance_audio: true,
      });

      expect(createCustomVoiceMock).toHaveBeenCalledWith(
        expect.objectContaining({
          voice_name: "Test Voice",
          gender: 2,
          description: "A warm female voice",
          language: 47,
          enhance_audio: true,
        }),
      );
    });

    it("handles audio fetch failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        statusText: "Not Found",
      });
      const wrapper = createMockClientWrapper();
      const config = createConfig();
      const tool = createVoiceCloneTool(wrapper, config);

      const result = await tool.execute("call-1", {
        audio_url: "https://example.com/missing.wav",
        voice_name: "Test Voice",
        gender: 1,
      });
      const details = (result as any).details;

      expect(details.error).toContain("Failed to fetch audio from URL");
    });

    it("handles API errors gracefully", async () => {
      const wrapper = {
        getClient: vi.fn().mockReturnValue({
          voiceCloning: {
            createCustomVoice: vi.fn().mockRejectedValue(new Error("Audio too short")),
          },
        }),
      } as unknown as CambClientWrapper;
      const config = createConfig();
      const tool = createVoiceCloneTool(wrapper, config);

      const result = await tool.execute("call-1", {
        audio_url: "https://example.com/voice.wav",
        voice_name: "Test Voice",
        gender: 1,
      });
      const details = (result as any).details;

      expect(details.error).toBe("Audio too short");
    });
  });
});
