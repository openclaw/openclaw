import { describe, expect, it } from "vitest";
import { __testing } from "./brave-web-search-provider.js";

const { resolveBraveBaseUrl, resolveBraveEndpoint } = __testing;

describe("brave web search provider", () => {
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

  it("falls back to the default Brave API base URL", () => {
    expect(resolveBraveBaseUrl()).toBe("https://api.search.brave.com");
    expect(resolveBraveEndpoint(resolveBraveBaseUrl(), "web")).toBe(
      "https://api.search.brave.com/res/v1/web/search",
    );
  });

  it("appends the Brave API path to bare custom origins", () => {
    expect(resolveBraveEndpoint("https://proxy.example.com", "web")).toBe(
      "https://proxy.example.com/res/v1/web/search",
    );
    expect(resolveBraveEndpoint("https://proxy.example.com", "llm-context")).toBe(
      "https://proxy.example.com/res/v1/llm/context",
    );
  });

  it("reuses reverse-proxy API roots that already end in /v1", () => {
    expect(resolveBraveEndpoint("https://proxy.example.com/resolver/v1/", "web")).toBe(
      "https://proxy.example.com/resolver/v1/web/search",
    );
    expect(resolveBraveEndpoint("https://proxy.example.com/res/v1", "llm-context")).toBe(
      "https://proxy.example.com/res/v1/llm/context",
    );
  });

  it("preserves custom path prefixes when appending the Brave API path", () => {
    expect(resolveBraveEndpoint("https://proxy.example.com/custom-prefix", "web")).toBe(
      "https://proxy.example.com/custom-prefix/res/v1/web/search",
    );
  });

  it("does not treat generic versioned proxy prefixes as Brave API roots", () => {
    expect(resolveBraveEndpoint("https://proxy.example.com/api/v1", "web")).toBe(
      "https://proxy.example.com/api/v1/res/v1/web/search",
    );
  });

  it("rejects invalid Brave base URLs instead of silently falling back", () => {
    expect(resolveBraveEndpoint("proxy.example.com", "web")).toBeUndefined();
    expect(resolveBraveEndpoint("ftp://proxy.example.com/resolver/v1/", "web")).toBeUndefined();
  });
});
