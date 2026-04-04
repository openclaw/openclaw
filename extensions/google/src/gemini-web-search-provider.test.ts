import { describe, expect, it } from "vitest";
import { withEnv } from "openclaw/plugin-sdk/testing";
import { __testing } from "./gemini-web-search-provider.js";

const geminiApiKeyEnv = ["GEMINI", "API", "KEY"].join("_");

describe("gemini web search provider", () => {
  it("uses configured model and base url overrides with sane defaults", () => {
    expect(__testing.resolveGeminiModel()).toBe("gemini-2.5-flash");
    expect(__testing.resolveGeminiModel({ model: "gemini-2.0-flash" })).toBe("gemini-2.0-flash");
    expect(__testing.resolveGeminiBaseUrl()).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
    expect(__testing.resolveGeminiBaseUrl({ baseUrl: "https://gemini.example/v1beta" })).toBe(
      "https://gemini.example/v1beta",
    );
  });

  it("strips trailing slashes and whitespace from the base url", () => {
    expect(__testing.resolveGeminiBaseUrl({ baseUrl: "https://gemini.example/v1beta/" })).toBe(
      "https://gemini.example/v1beta",
    );
    expect(__testing.resolveGeminiBaseUrl({ baseUrl: "  https://gemini.example/v1beta  " })).toBe(
      "https://gemini.example/v1beta",
    );
  });

  it("normalizes a host-only Google endpoint to the canonical /v1beta path", () => {
    expect(
      __testing.resolveGeminiBaseUrl({ baseUrl: "https://generativelanguage.googleapis.com" }),
    ).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(
      __testing.resolveGeminiBaseUrl({ baseUrl: "https://generativelanguage.googleapis.com/" }),
    ).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("uses config apiKey when provided", () => {
    expect(__testing.resolveGeminiApiKey({ apiKey: "gemini-test-key" })).toBe("gemini-test-key");
  });

  it("falls back to env apiKey", () => {
    withEnv({ [geminiApiKeyEnv]: "gemini-env-key" }, () => {
      expect(__testing.resolveGeminiApiKey({})).toBe("gemini-env-key");
    });
  });
});
