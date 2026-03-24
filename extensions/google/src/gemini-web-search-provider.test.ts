import { describe, expect, it } from "vitest";
import { __testing } from "./gemini-web-search-provider.js";

describe("gemini web search provider", () => {
  it("prefers scoped configured api keys over environment fallbacks", () => {
    expect(
      __testing.resolveGeminiApiKey({
        apiKey: "gemini-secret",
      }),
    ).toBe("gemini-secret");
  });

  it("falls back to the default Gemini model when unset or blank", () => {
    expect(__testing.resolveGeminiModel()).toBe("gemini-2.5-flash");
    expect(__testing.resolveGeminiModel({ model: "  " })).toBe("gemini-2.5-flash");
    expect(__testing.resolveGeminiModel({ model: "gemini-2.5-pro" })).toBe("gemini-2.5-pro");
  });
});

describe("gemini web search baseUrl resolution", () => {
  it("returns default baseUrl when not configured", () => {
    expect(__testing.resolveGeminiBaseUrl()).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
    expect(__testing.resolveGeminiBaseUrl({})).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
  });

  it("returns configured baseUrl", () => {
    expect(__testing.resolveGeminiBaseUrl({ baseUrl: "https://proxy.example.com/gemini" })).toBe(
      "https://proxy.example.com/gemini",
    );
  });

  it("strips trailing slash", () => {
    expect(__testing.resolveGeminiBaseUrl({ baseUrl: "https://proxy.example.com/gemini/" })).toBe(
      "https://proxy.example.com/gemini",
    );
  });

  it("trims whitespace", () => {
    expect(
      __testing.resolveGeminiBaseUrl({ baseUrl: "  https://proxy.example.com/gemini  " }),
    ).toBe("https://proxy.example.com/gemini");
  });

  it("normalizes host-only Google endpoint to canonical /v1beta base", () => {
    expect(
      __testing.resolveGeminiBaseUrl({ baseUrl: "https://generativelanguage.googleapis.com" }),
    ).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(
      __testing.resolveGeminiBaseUrl({ baseUrl: "https://generativelanguage.googleapis.com/" }),
    ).toBe("https://generativelanguage.googleapis.com/v1beta");
  });
});
