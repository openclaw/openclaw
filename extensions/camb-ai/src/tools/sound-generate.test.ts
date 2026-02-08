import { describe, expect, it, vi } from "vitest";
import type { CambClientWrapper } from "../client.js";
import type { CambAiConfig } from "../config.js";
import { createSoundGenerateTool } from "./sound-generate.js";

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
    soundGeneration: { enabled: true },
    pollingIntervalMs: 100,
    pollingTimeoutMs: 1000,
    ...overrides,
  };
}

function createMockClientWrapper(
  taskId = "sound-task-123",
  audioUrl = "https://example.com/audio.mp3",
): CambClientWrapper {
  const mockClient = {
    textToAudio: {
      createTextToAudio: vi.fn().mockResolvedValue({ task_id: taskId }),
      getTextToAudioStatus: vi.fn().mockResolvedValue({ status: "SUCCESS", run_id: 42 }),
      getTextToSoundResults: vi.fn().mockResolvedValue({
        "42": { audio_url: audioUrl },
      }),
    },
  };

  return {
    getClient: vi.fn().mockReturnValue(mockClient),
    pollForCompletion: vi.fn().mockImplementation(async (_check, getResult) => {
      return getResult(42);
    }),
  } as unknown as CambClientWrapper;
}

describe("camb_sound_generate tool", () => {
  it("has correct tool metadata", () => {
    const wrapper = createMockClientWrapper();
    const config = createConfig();
    const tool = createSoundGenerateTool(wrapper, config);

    expect(tool.name).toBe("camb_sound_generate");
    expect(tool.label).toBe("Camb AI Sound Generate");
    expect(tool.description).toContain("Generate music or sound effects");
  });

  describe("execute", () => {
    it("returns error when sound generation is disabled", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig({ soundGeneration: { enabled: false } });
      const tool = createSoundGenerateTool(wrapper, config);

      const result = await tool.execute("call-1", {
        prompt: "upbeat music",
      });
      const details = (result as any).details;

      expect(details.error).toContain("Sound generation is disabled");
    });

    it("returns error when prompt is missing", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig();
      const tool = createSoundGenerateTool(wrapper, config);

      const result = await tool.execute("call-1", {});
      const details = (result as any).details;

      expect(details.error).toBe("prompt is required");
    });

    it("returns error when prompt is empty", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig();
      const tool = createSoundGenerateTool(wrapper, config);

      const result = await tool.execute("call-1", { prompt: "   " });
      const details = (result as any).details;

      expect(details.error).toBe("prompt is required");
    });

    it("generates sound successfully with defaults", async () => {
      const wrapper = createMockClientWrapper("task-abc");
      const config = createConfig();
      const tool = createSoundGenerateTool(wrapper, config);

      const result = await tool.execute("call-1", {
        prompt: "thunderstorm with rain",
      });
      const details = (result as any).details;

      expect(details.success).toBe(true);
      expect(details.task_id).toBe("task-abc");
      expect(details.prompt).toBe("thunderstorm with rain");
      expect(details.duration).toBe(10); // Default
      expect(details.audio_type).toBe("sound"); // Default
    });

    it("generates music when audio_type is music", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig();
      const tool = createSoundGenerateTool(wrapper, config);

      const result = await tool.execute("call-1", {
        prompt: "upbeat electronic track",
        audio_type: "music",
      });
      const details = (result as any).details;

      expect(details.success).toBe(true);
      expect(details.audio_type).toBe("music");
    });

    it("uses custom duration when provided", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig();
      const tool = createSoundGenerateTool(wrapper, config);

      const result = await tool.execute("call-1", {
        prompt: "birds chirping",
        duration: 30,
      });
      const details = (result as any).details;

      expect(details.success).toBe(true);
      expect(details.duration).toBe(30);
    });

    it("calls API with correct parameters", async () => {
      const createTextToAudioMock = vi.fn().mockResolvedValue({ task_id: "sound-task-123" });
      const wrapper = {
        getClient: vi.fn().mockReturnValue({
          textToAudio: {
            createTextToAudio: createTextToAudioMock,
            getTextToAudioStatus: vi.fn().mockResolvedValue({ status: "SUCCESS", run_id: 42 }),
            getTextToSoundResults: vi.fn().mockResolvedValue({ "42": { audio_url: "test.mp3" } }),
          },
        }),
        pollForCompletion: vi.fn().mockImplementation(async (_check, getResult) => getResult(42)),
      } as unknown as CambClientWrapper;
      const config = createConfig();
      const tool = createSoundGenerateTool(wrapper, config);

      await tool.execute("call-1", {
        prompt: "ocean waves",
        duration: 15,
        audio_type: "sound",
      });

      expect(createTextToAudioMock).toHaveBeenCalledWith({
        prompt: "ocean waves",
        duration: 15,
        audio_type: "sound",
      });
    });

    it("defaults to sound type for invalid audio_type", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig();
      const tool = createSoundGenerateTool(wrapper, config);

      const result = await tool.execute("call-1", {
        prompt: "test",
        audio_type: "invalid",
      });
      const details = (result as any).details;

      expect(details.audio_type).toBe("sound");
    });

    it("handles task creation failure", async () => {
      const wrapper = {
        getClient: vi.fn().mockReturnValue({
          textToAudio: {
            createTextToAudio: vi.fn().mockResolvedValue({}), // No task_id
          },
        }),
        pollForCompletion: vi.fn(),
      } as unknown as CambClientWrapper;
      const config = createConfig();
      const tool = createSoundGenerateTool(wrapper, config);

      const result = await tool.execute("call-1", {
        prompt: "test sound",
      });
      const details = (result as any).details;

      expect(details.error).toBe("Failed to create sound generation task");
    });

    it("handles API errors gracefully", async () => {
      const wrapper = {
        getClient: vi.fn().mockReturnValue({
          textToAudio: {
            createTextToAudio: vi.fn().mockRejectedValue(new Error("Rate limit exceeded")),
          },
        }),
        pollForCompletion: vi.fn(),
      } as unknown as CambClientWrapper;
      const config = createConfig();
      const tool = createSoundGenerateTool(wrapper, config);

      const result = await tool.execute("call-1", {
        prompt: "test",
      });
      const details = (result as any).details;

      expect(details.error).toBe("Rate limit exceeded");
    });

    it("includes result from polling completion", async () => {
      const wrapper = createMockClientWrapper("task-xyz", "https://cdn.camb.ai/generated.mp3");
      const config = createConfig();
      const tool = createSoundGenerateTool(wrapper, config);

      const result = await tool.execute("call-1", {
        prompt: "calm music",
      });
      const details = (result as any).details;

      expect(details.success).toBe(true);
      expect(details.result).toBeDefined();
      expect(details.result.audio_url).toBe("https://cdn.camb.ai/generated.mp3");
    });
  });
});
