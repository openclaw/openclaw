import { describe, it, expect } from "vitest";
import { shouldForceResponsesStore } from "./openai-stream-wrappers.js";

describe("shouldForceResponsesStore", () => {
  it("returns true for direct OpenAI URL", () => {
    expect(
      shouldForceResponsesStore({
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com",
      }),
    ).toBe(true);
  });

  it("returns false for proxy URL without compat opt-in", () => {
    expect(
      shouldForceResponsesStore({
        api: "openai-responses",
        provider: "openai",
        baseUrl: "http://localhost:3141",
      }),
    ).toBe(false);
  });

  it("returns true for proxy URL with compat.supportsStore: true", () => {
    expect(
      shouldForceResponsesStore({
        api: "openai-responses",
        provider: "openai",
        baseUrl: "http://localhost:3141",
        compat: { supportsStore: true },
      }),
    ).toBe(true);
  });

  it("returns false for proxy URL with compat.supportsStore: false", () => {
    expect(
      shouldForceResponsesStore({
        api: "openai-responses",
        provider: "openai",
        baseUrl: "http://localhost:3141",
        compat: { supportsStore: false },
      }),
    ).toBe(false);
  });

  it("returns false for unknown provider even with supportsStore: true", () => {
    expect(
      shouldForceResponsesStore({
        api: "openai-responses",
        provider: "unknown-proxy",
        baseUrl: "http://localhost:3141",
        compat: { supportsStore: true },
      }),
    ).toBe(false);
  });

  it("returns false for non-responses API", () => {
    expect(
      shouldForceResponsesStore({
        api: "openai-completions",
        provider: "openai",
        baseUrl: "https://api.openai.com",
      }),
    ).toBe(false);
  });
});
