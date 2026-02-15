import { describe, expect, it } from "vitest";
import { isDirectOpenAIBaseUrl, shouldForceResponsesStore } from "./extra-params.js";

describe("isDirectOpenAIBaseUrl", () => {
  it("returns true for undefined (missing baseUrl → assume direct OpenAI)", () => {
    expect(isDirectOpenAIBaseUrl(undefined)).toBe(true);
  });

  it("returns true for null", () => {
    expect(isDirectOpenAIBaseUrl(null)).toBe(true);
  });

  it("returns false for empty string (provider-level sentinel)", () => {
    expect(isDirectOpenAIBaseUrl("")).toBe(false);
  });

  it("returns false for whitespace-only string", () => {
    expect(isDirectOpenAIBaseUrl("   ")).toBe(false);
  });

  it("returns true for api.openai.com URL", () => {
    expect(isDirectOpenAIBaseUrl("https://api.openai.com/v1")).toBe(true);
  });

  it("returns true for chatgpt.com URL", () => {
    expect(isDirectOpenAIBaseUrl("https://chatgpt.com/backend-api")).toBe(true);
  });

  it("returns false for third-party URLs", () => {
    expect(isDirectOpenAIBaseUrl("https://my-proxy.example.com/v1")).toBe(false);
  });

  it("returns false for Azure OpenAI URLs", () => {
    expect(isDirectOpenAIBaseUrl("https://my-instance.openai.azure.com/openai")).toBe(false);
  });
});

describe("shouldForceResponsesStore", () => {
  it("forces store for direct OpenAI responses models", () => {
    expect(
      shouldForceResponsesStore({
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
      }),
    ).toBe(true);
  });

  it("does NOT force store for azure-openai-responses provider", () => {
    expect(
      shouldForceResponsesStore({
        api: "openai-responses",
        provider: "azure-openai-responses",
        baseUrl: "",
      }),
    ).toBe(false);
  });

  it("does NOT force store for openai-codex-responses API", () => {
    expect(
      shouldForceResponsesStore({
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
      }),
    ).toBe(false);
  });

  it("does NOT force store for empty baseUrl even with openai provider", () => {
    expect(
      shouldForceResponsesStore({
        api: "openai-responses",
        provider: "openai",
        baseUrl: "",
      }),
    ).toBe(false);
  });

  it("does NOT force store for third-party proxy baseUrl", () => {
    expect(
      shouldForceResponsesStore({
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://my-proxy.example.com/v1",
      }),
    ).toBe(false);
  });

  it("forces store when baseUrl is undefined and provider is openai + openai-responses", () => {
    expect(
      shouldForceResponsesStore({
        api: "openai-responses",
        provider: "openai",
        baseUrl: undefined,
      }),
    ).toBe(true);
  });

  it("does NOT force store when api/provider are missing", () => {
    expect(shouldForceResponsesStore({})).toBe(false);
  });
});
