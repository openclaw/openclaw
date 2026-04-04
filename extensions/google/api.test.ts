import { describe, expect, it } from "vitest";
import {
  isGoogleGenerativeAiApi,
  normalizeGoogleGenerativeAiBaseUrl,
  parseGeminiAuth,
  resolveGoogleGenerativeAiApiOrigin,
  resolveGoogleGenerativeAiTransport,
  shouldNormalizeGoogleGenerativeAiProviderConfig,
} from "./api.js";

describe("google generative ai helpers", () => {
  it("detects the Google Generative AI transport id", () => {
    expect(isGoogleGenerativeAiApi("google-generative-ai")).toBe(true);
    expect(isGoogleGenerativeAiApi("google-gemini-cli")).toBe(false);
    expect(isGoogleGenerativeAiApi(undefined)).toBe(false);
  });

  it("normalizes only explicit Google Generative AI baseUrls", () => {
    expect(normalizeGoogleGenerativeAiBaseUrl("https://generativelanguage.googleapis.com")).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
    expect(normalizeGoogleGenerativeAiBaseUrl("https://proxy.example.com/google/v1beta")).toBe(
      "https://proxy.example.com/google/v1beta",
    );
    expect(normalizeGoogleGenerativeAiBaseUrl("https://aiplatform.googleapis.com")).toBe(
      "https://aiplatform.googleapis.com",
    );
    expect(normalizeGoogleGenerativeAiBaseUrl("proxy/generativelanguage.googleapis.com")).toBe(
      "proxy/generativelanguage.googleapis.com",
    );
    expect(normalizeGoogleGenerativeAiBaseUrl("generativelanguage.googleapis.com")).toBe(
      "generativelanguage.googleapis.com",
    );
    expect(normalizeGoogleGenerativeAiBaseUrl("https://xgenerativelanguage.googleapis.com")).toBe(
      "https://xgenerativelanguage.googleapis.com",
    );
    expect(normalizeGoogleGenerativeAiBaseUrl()).toBeUndefined();
  });

  it("normalizes Google provider configs by provider key, provider api, or model api", () => {
    expect(
      shouldNormalizeGoogleGenerativeAiProviderConfig("google", {
        models: [{ api: "openai-completions" }],
      }),
    ).toBe(true);
    expect(
      shouldNormalizeGoogleGenerativeAiProviderConfig("custom", {
        api: "google-generative-ai",
        models: [{ api: "openai-completions" }],
      }),
    ).toBe(true);
    expect(
      shouldNormalizeGoogleGenerativeAiProviderConfig("custom", {
        models: [{ api: "google-generative-ai" }],
      }),
    ).toBe(true);
    expect(
      shouldNormalizeGoogleGenerativeAiProviderConfig("custom", {
        api: "openai-completions",
        models: [{ api: "openai-completions" }],
      }),
    ).toBe(false);
  });

  it("normalizes transport baseUrls only for Google Generative AI", () => {
    expect(
      resolveGoogleGenerativeAiTransport({
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com",
      }),
    ).toEqual({
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    });
    expect(
      resolveGoogleGenerativeAiTransport({
        api: "openai-completions",
        baseUrl: "https://generativelanguage.googleapis.com",
      }),
    ).toEqual({
      api: "openai-completions",
      baseUrl: "https://generativelanguage.googleapis.com",
    });
  });

  it("derives the Gemini API origin without duplicating /v1beta", () => {
    expect(resolveGoogleGenerativeAiApiOrigin()).toBe("https://generativelanguage.googleapis.com");
    expect(resolveGoogleGenerativeAiApiOrigin("https://generativelanguage.googleapis.com")).toBe(
      "https://generativelanguage.googleapis.com",
    );
    expect(
      resolveGoogleGenerativeAiApiOrigin("https://generativelanguage.googleapis.com/v1beta"),
    ).toBe("https://generativelanguage.googleapis.com");
  });

  it("parses project-aware oauth auth payloads into bearer headers", () => {
    expect(parseGeminiAuth(JSON.stringify({ token: "oauth-token", projectId: "project-1" }))).toEqual({
      headers: {
        Authorization: "Bearer oauth-token",
        "Content-Type": "application/json",
      },
    });
  });

  it("falls back to API key headers for raw tokens", () => {
    expect(parseGeminiAuth("api-key-123")).toEqual({
      headers: {
        "x-goog-api-key": "api-key-123",
        "Content-Type": "application/json",
      },
    });
  });
});
