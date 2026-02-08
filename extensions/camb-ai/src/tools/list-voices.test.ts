import { describe, expect, it, vi } from "vitest";
import type { CambClientWrapper } from "../client.js";
import { createListVoicesTool } from "./list-voices.js";

function createMockClientWrapper(voices: unknown[] = []): CambClientWrapper {
  return {
    getClient: vi.fn().mockReturnValue({
      voiceCloning: {
        listVoices: vi.fn().mockResolvedValue(voices),
      },
    }),
  } as unknown as CambClientWrapper;
}

describe("camb_list_voices tool", () => {
  it("has correct tool metadata", () => {
    const wrapper = createMockClientWrapper();
    const tool = createListVoicesTool(wrapper);

    expect(tool.name).toBe("camb_list_voices");
    expect(tool.label).toBe("Camb AI List Voices");
    expect(tool.description).toContain("available voices");
  });

  describe("execute", () => {
    it("returns empty list when no voices available", async () => {
      const wrapper = createMockClientWrapper([]);
      const tool = createListVoicesTool(wrapper);

      const result = await tool.execute("call-1", {});
      const details = (result as any).details;

      expect(details.success).toBe(true);
      expect(details.count).toBe(0);
      expect(details.voices).toEqual([]);
    });

    it("returns list of voices with mapped fields", async () => {
      const mockVoices = [
        { id: 1, voice_name: "Alice", gender: "female", language: "en-us" },
        { id: 2, voice_name: "Bob", gender: "male", language: "en-gb" },
      ];
      const wrapper = createMockClientWrapper(mockVoices);
      const tool = createListVoicesTool(wrapper);

      const result = await tool.execute("call-1", {});
      const details = (result as any).details;

      expect(details.success).toBe(true);
      expect(details.count).toBe(2);
      expect(details.voices).toEqual([
        { id: 1, name: "Alice", gender: "female", language: "en-us" },
        { id: 2, name: "Bob", gender: "male", language: "en-gb" },
      ]);
    });

    it("handles voices with missing optional fields", async () => {
      const mockVoices = [{ id: 1, voice_name: "Unknown" }];
      const wrapper = createMockClientWrapper(mockVoices);
      const tool = createListVoicesTool(wrapper);

      const result = await tool.execute("call-1", {});
      const details = (result as any).details;

      expect(details.success).toBe(true);
      expect(details.voices[0]).toEqual({
        id: 1,
        name: "Unknown",
        gender: undefined,
        language: undefined,
      });
    });

    it("handles API errors gracefully", async () => {
      const wrapper = {
        getClient: vi.fn().mockReturnValue({
          voiceCloning: {
            listVoices: vi.fn().mockRejectedValue(new Error("Network error")),
          },
        }),
      } as unknown as CambClientWrapper;
      const tool = createListVoicesTool(wrapper);

      const result = await tool.execute("call-1", {});
      const details = (result as any).details;

      expect(details.error).toBe("Network error");
    });

    it("returns JSON content format", async () => {
      const mockVoices = [{ id: 1, voice_name: "Test" }];
      const wrapper = createMockClientWrapper(mockVoices);
      const tool = createListVoicesTool(wrapper);

      const result = await tool.execute("call-1", {});

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe("text");
      expect(typeof result.content[0].text).toBe("string");
      // Verify it's valid JSON
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
    });
  });
});
