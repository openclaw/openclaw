import { describe, expect, it, vi } from "vitest";
import type { CambClientWrapper } from "../client.js";
import { createListLanguagesTool } from "./list-languages.js";

function createMockClientWrapper(
  sourceLanguages: unknown[] = [],
  targetLanguages: unknown[] = [],
): CambClientWrapper {
  return {
    getClient: vi.fn().mockReturnValue({
      languages: {
        getSourceLanguages: vi.fn().mockResolvedValue(sourceLanguages),
        getTargetLanguages: vi.fn().mockResolvedValue(targetLanguages),
      },
    }),
  } as unknown as CambClientWrapper;
}

describe("camb_list_languages tool", () => {
  it("has correct tool metadata", () => {
    const wrapper = createMockClientWrapper();
    const tool = createListLanguagesTool(wrapper);

    expect(tool.name).toBe("camb_list_languages");
    expect(tool.label).toBe("Camb AI List Languages");
    expect(tool.description).toContain("available languages");
  });

  describe("execute", () => {
    it("returns source languages by default", async () => {
      const sourceLanguages = [
        { id: 1, language: "English", shortName: "en" },
        { id: 2, language: "Spanish", shortName: "es" },
      ];
      const wrapper = createMockClientWrapper(sourceLanguages, []);
      const tool = createListLanguagesTool(wrapper);

      const result = await tool.execute("call-1", {});
      const details = (result as any).details;

      expect(details.success).toBe(true);
      expect(details.type).toBe("source");
      expect(details.count).toBe(2);
      expect(details.languages).toEqual([
        { id: 1, name: "English", code: "en" },
        { id: 2, name: "Spanish", code: "es" },
      ]);
    });

    it("returns source languages when type is source", async () => {
      const sourceLanguages = [{ id: 1, language: "French", shortName: "fr" }];
      const wrapper = createMockClientWrapper(sourceLanguages, []);
      const tool = createListLanguagesTool(wrapper);

      const result = await tool.execute("call-1", { type: "source" });
      const details = (result as any).details;

      expect(details.success).toBe(true);
      expect(details.type).toBe("source");
      expect(details.languages[0].name).toBe("French");
    });

    it("returns target languages when type is target", async () => {
      const targetLanguages = [
        { id: 10, language: "German", shortName: "de" },
        { id: 11, language: "Italian", shortName: "it" },
      ];
      const wrapper = createMockClientWrapper([], targetLanguages);
      const tool = createListLanguagesTool(wrapper);

      const result = await tool.execute("call-1", { type: "target" });
      const details = (result as any).details;

      expect(details.success).toBe(true);
      expect(details.type).toBe("target");
      expect(details.count).toBe(2);
      expect(details.languages).toEqual([
        { id: 10, name: "German", code: "de" },
        { id: 11, name: "Italian", code: "it" },
      ]);
    });

    it("returns empty list when no languages available", async () => {
      const wrapper = createMockClientWrapper([], []);
      const tool = createListLanguagesTool(wrapper);

      const result = await tool.execute("call-1", {});
      const details = (result as any).details;

      expect(details.success).toBe(true);
      expect(details.count).toBe(0);
      expect(details.languages).toEqual([]);
    });

    it("handles API errors gracefully", async () => {
      const wrapper = {
        getClient: vi.fn().mockReturnValue({
          languages: {
            getSourceLanguages: vi.fn().mockRejectedValue(new Error("Service unavailable")),
            getTargetLanguages: vi.fn(),
          },
        }),
      } as unknown as CambClientWrapper;
      const tool = createListLanguagesTool(wrapper);

      const result = await tool.execute("call-1", {});
      const details = (result as any).details;

      expect(details.error).toBe("Service unavailable");
    });

    it("treats invalid type as source", async () => {
      const sourceLanguages = [{ id: 1, language: "Portuguese", shortName: "pt" }];
      const wrapper = createMockClientWrapper(sourceLanguages, []);
      const tool = createListLanguagesTool(wrapper);

      const result = await tool.execute("call-1", { type: "invalid" });
      const details = (result as any).details;

      expect(details.success).toBe(true);
      expect(details.type).toBe("invalid"); // Passes through but uses source endpoint
      expect(details.languages[0].name).toBe("Portuguese");
    });
  });
});
