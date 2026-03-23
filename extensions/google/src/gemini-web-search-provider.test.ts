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
