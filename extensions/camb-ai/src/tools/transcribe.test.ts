import { describe, expect, it, vi } from "vitest";
import type { CambClientWrapper } from "../client.js";
import type { CambAiConfig } from "../config.js";
import { createTranscribeTool } from "./transcribe.js";

function createConfig(): CambAiConfig {
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
    pollingIntervalMs: 100,
    pollingTimeoutMs: 1000,
  };
}

function createMockClientWrapper(
  taskId = "task-123",
  transcript = "Hello world",
): CambClientWrapper {
  const mockClient = {
    transcription: {
      createTranscription: vi.fn().mockResolvedValue({ task_id: taskId }),
      getTranscriptionTaskStatus: vi.fn().mockResolvedValue({ status: "SUCCESS", run_id: 42 }),
      getTranscriptionResult: vi.fn().mockResolvedValue({ transcript }),
    },
  };

  return {
    getClient: vi.fn().mockReturnValue(mockClient),
    pollForCompletion: vi.fn().mockImplementation(async (_check, getResult) => {
      return getResult(42);
    }),
  } as unknown as CambClientWrapper;
}

describe("camb_transcribe tool", () => {
  it("has correct tool metadata", () => {
    const wrapper = createMockClientWrapper();
    const config = createConfig();
    const tool = createTranscribeTool(wrapper, config);

    expect(tool.name).toBe("camb_transcribe");
    expect(tool.label).toBe("Camb AI Transcribe");
    expect(tool.description).toContain("Transcribe audio");
  });

  describe("execute", () => {
    it("returns error when audio_source is missing", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig();
      const tool = createTranscribeTool(wrapper, config);

      const result = await tool.execute("call-1", {});
      const details = (result as any).details;

      expect(details.error).toBe("audio_source is required");
    });

    it("returns error when audio_source is empty", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig();
      const tool = createTranscribeTool(wrapper, config);

      const result = await tool.execute("call-1", { audio_source: "  " });
      const details = (result as any).details;

      expect(details.error).toBe("audio_source is required");
    });

    it("transcribes audio successfully", async () => {
      const wrapper = createMockClientWrapper("task-456", "This is the transcribed text");
      const config = createConfig();
      const tool = createTranscribeTool(wrapper, config);

      const result = await tool.execute("call-1", {
        audio_source: "https://example.com/audio.mp3",
      });
      const details = (result as any).details;

      expect(details.success).toBe(true);
      expect(details.task_id).toBe("task-456");
      expect(details.transcript).toBe("This is the transcribed text");
      expect(details.language_id).toBe(47); // Default English
    });

    it("uses custom language ID when provided", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig();
      const tool = createTranscribeTool(wrapper, config);

      const result = await tool.execute("call-1", {
        audio_source: "https://example.com/audio.mp3",
        language: 50, // Spanish
      });
      const details = (result as any).details;

      expect(details.success).toBe(true);
      expect(details.language_id).toBe(50);
    });

    it("passes word_timestamps parameter", async () => {
      const wrapper = createMockClientWrapper();
      const config = createConfig();
      const tool = createTranscribeTool(wrapper, config);

      const result = await tool.execute("call-1", {
        audio_source: "https://example.com/audio.mp3",
        word_timestamps: true,
      });
      const details = (result as any).details;

      expect(details.success).toBe(true);
      expect(details.word_timestamps).toBeDefined();
    });

    it("calls client with correct parameters", async () => {
      const createTranscriptionMock = vi.fn().mockResolvedValue({ task_id: "task-123" });
      const wrapper = {
        getClient: vi.fn().mockReturnValue({
          transcription: {
            createTranscription: createTranscriptionMock,
            getTranscriptionTaskStatus: vi
              .fn()
              .mockResolvedValue({ status: "SUCCESS", run_id: 42 }),
            getTranscriptionResult: vi.fn().mockResolvedValue({ transcript: "test" }),
          },
        }),
        pollForCompletion: vi.fn().mockImplementation(async (_check, getResult) => getResult(42)),
      } as unknown as CambClientWrapper;
      const config = createConfig();
      const tool = createTranscribeTool(wrapper, config);

      await tool.execute("call-1", {
        audio_source: "https://example.com/test.wav",
        language: 99,
      });

      expect(createTranscriptionMock).toHaveBeenCalledWith({
        media_url: "https://example.com/test.wav",
        language: 99,
      });
    });

    it("handles task creation failure", async () => {
      const wrapper = {
        getClient: vi.fn().mockReturnValue({
          transcription: {
            createTranscription: vi.fn().mockResolvedValue({}), // No task_id
          },
        }),
        pollForCompletion: vi.fn(),
      } as unknown as CambClientWrapper;
      const config = createConfig();
      const tool = createTranscribeTool(wrapper, config);

      const result = await tool.execute("call-1", {
        audio_source: "https://example.com/audio.mp3",
      });
      const details = (result as any).details;

      expect(details.error).toBe("Failed to create transcription task");
    });

    it("handles API errors gracefully", async () => {
      const wrapper = {
        getClient: vi.fn().mockReturnValue({
          transcription: {
            createTranscription: vi.fn().mockRejectedValue(new Error("Invalid audio format")),
          },
        }),
        pollForCompletion: vi.fn(),
      } as unknown as CambClientWrapper;
      const config = createConfig();
      const tool = createTranscribeTool(wrapper, config);

      const result = await tool.execute("call-1", {
        audio_source: "https://example.com/audio.mp3",
      });
      const details = (result as any).details;

      expect(details.error).toBe("Invalid audio format");
    });
  });
});
