import { describe, expect, it, vi } from "vitest";
import type { CambClientWrapper } from "../client.js";
import { createTranslateTool } from "./translate.js";

function createMockClientWrapper(translatedText = "Translated text"): CambClientWrapper {
  return {
    getClient: vi.fn().mockReturnValue({
      translation: {
        translationStream: vi.fn().mockResolvedValue(translatedText),
      },
    }),
  } as unknown as CambClientWrapper;
}

describe("camb_translate tool", () => {
  it("has correct tool metadata", () => {
    const wrapper = createMockClientWrapper();
    const tool = createTranslateTool(wrapper);

    expect(tool.name).toBe("camb_translate");
    expect(tool.label).toBe("Camb AI Translate");
    expect(tool.description).toContain("Translate text");
    expect(tool.description).toContain("140+");
  });

  describe("execute", () => {
    it("returns error when text is missing", async () => {
      const wrapper = createMockClientWrapper();
      const tool = createTranslateTool(wrapper);

      const result = await tool.execute("call-1", {
        source_language: 1,
        target_language: 2,
      });
      const details = (result as any).details;

      expect(details.error).toBe("text is required");
    });

    it("returns error when text is empty", async () => {
      const wrapper = createMockClientWrapper();
      const tool = createTranslateTool(wrapper);

      const result = await tool.execute("call-1", {
        text: "   ",
        source_language: 1,
        target_language: 2,
      });
      const details = (result as any).details;

      expect(details.error).toBe("text is required");
    });

    it("returns error when source_language is missing", async () => {
      const wrapper = createMockClientWrapper();
      const tool = createTranslateTool(wrapper);

      const result = await tool.execute("call-1", {
        text: "Hello",
        target_language: 2,
      });
      const details = (result as any).details;

      expect(details.error).toBe("source_language and target_language (numeric IDs) are required");
    });

    it("returns error when target_language is missing", async () => {
      const wrapper = createMockClientWrapper();
      const tool = createTranslateTool(wrapper);

      const result = await tool.execute("call-1", {
        text: "Hello",
        source_language: 1,
      });
      const details = (result as any).details;

      expect(details.error).toBe("source_language and target_language (numeric IDs) are required");
    });

    it("returns error when language IDs are not numbers", async () => {
      const wrapper = createMockClientWrapper();
      const tool = createTranslateTool(wrapper);

      const result = await tool.execute("call-1", {
        text: "Hello",
        source_language: "en",
        target_language: "es",
      });
      const details = (result as any).details;

      expect(details.error).toBe("source_language and target_language (numeric IDs) are required");
    });

    it("translates text successfully", async () => {
      const wrapper = createMockClientWrapper("Hola mundo");
      const tool = createTranslateTool(wrapper);

      const result = await tool.execute("call-1", {
        text: "Hello world",
        source_language: 47, // English
        target_language: 50, // Spanish
      });
      const details = (result as any).details;

      expect(details.success).toBe(true);
      expect(details.original_text).toBe("Hello world");
      expect(details.translated_text).toBe("Hola mundo");
      expect(details.source_language).toBe(47);
      expect(details.target_language).toBe(50);
    });

    it("calls API with correct parameters", async () => {
      const translationStreamMock = vi.fn().mockResolvedValue("Translated");
      const wrapper = {
        getClient: vi.fn().mockReturnValue({
          translation: { translationStream: translationStreamMock },
        }),
      } as unknown as CambClientWrapper;
      const tool = createTranslateTool(wrapper);

      await tool.execute("call-1", {
        text: "Test text",
        source_language: 1,
        target_language: 2,
      });

      expect(translationStreamMock).toHaveBeenCalledWith({
        text: "Test text",
        source_language: 1,
        target_language: 2,
      });
    });

    it("trims whitespace from text", async () => {
      const translationStreamMock = vi.fn().mockResolvedValue("Translated");
      const wrapper = {
        getClient: vi.fn().mockReturnValue({
          translation: { translationStream: translationStreamMock },
        }),
      } as unknown as CambClientWrapper;
      const tool = createTranslateTool(wrapper);

      await tool.execute("call-1", {
        text: "  Hello  ",
        source_language: 1,
        target_language: 2,
      });

      expect(translationStreamMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Hello" }),
      );
    });

    it("handles API errors gracefully", async () => {
      const wrapper = {
        getClient: vi.fn().mockReturnValue({
          translation: {
            translationStream: vi.fn().mockRejectedValue(new Error("Unsupported language pair")),
          },
        }),
      } as unknown as CambClientWrapper;
      const tool = createTranslateTool(wrapper);

      const result = await tool.execute("call-1", {
        text: "Hello",
        source_language: 1,
        target_language: 999,
      });
      const details = (result as any).details;

      expect(details.error).toBe("Unsupported language pair");
    });
  });
});
