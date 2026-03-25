import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing, createBraveWebSearchProvider } from "./brave-web-search-provider.js";

describe("brave web search provider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes brave language parameters and swaps reversed ui/search inputs", () => {
    expect(
      __testing.normalizeBraveLanguageParams({
        search_lang: "en-US",
        ui_lang: "ja",
      }),
    ).toEqual({
      search_lang: "jp",
      ui_lang: "en-US",
    });
  });

  it("flags invalid brave language fields", () => {
    expect(
      __testing.normalizeBraveLanguageParams({
        search_lang: "xx",
      }),
    ).toEqual({ invalidField: "search_lang" });
  });

  it("defaults brave mode to web unless llm-context is explicitly selected", () => {
    expect(__testing.resolveBraveMode()).toBe("web");
    expect(__testing.resolveBraveMode({ mode: "llm-context" })).toBe("llm-context");
  });

  it("maps llm-context results into wrapped source entries", () => {
    expect(
      __testing.mapBraveLlmContextResults({
        grounding: {
          generic: [
            {
              url: "https://example.com/post",
              title: "Example",
              snippets: ["a", "", "b"],
            },
          ],
        },
      }),
    ).toEqual([
      {
        url: "https://example.com/post",
        title: "Example",
        snippets: ["a", "b"],
        siteName: "example.com",
      },
    ]);
  });

  it("returns validation errors for invalid date ranges", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    const provider = createBraveWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "BSA...",
        brave: { apiKey: "BSA..." },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "latest gpu news",
      date_after: "2026-03-20",
      date_before: "2026-03-01",
    });

    expect(result).toMatchObject({
      error: "invalid_date_range",
    });
  });
});
