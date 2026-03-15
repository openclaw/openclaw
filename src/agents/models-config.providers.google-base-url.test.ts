import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeGoogleBaseUrl,
  normalizeProviders,
  type ProviderConfig,
} from "./models-config.providers.js";

describe("normalizeGoogleBaseUrl", () => {
  it.each([
    // bare host – the regression case from #41276
    [
      "https://generativelanguage.googleapis.com",
      "https://generativelanguage.googleapis.com/v1beta",
    ],
    // trailing slash stripped then /v1beta appended
    [
      "https://generativelanguage.googleapis.com/",
      "https://generativelanguage.googleapis.com/v1beta",
    ],
    // multiple trailing slashes
    [
      "https://generativelanguage.googleapis.com///",
      "https://generativelanguage.googleapis.com/v1beta",
    ],
    // query string preserved correctly via pathname mutation
    [
      "https://generativelanguage.googleapis.com?key=abc",
      "https://generativelanguage.googleapis.com/v1beta?key=abc",
    ],
  ])("appends /v1beta to bare googleapis.com host: %s", (input, expected) => {
    expect(normalizeGoogleBaseUrl(input)).toBe(expected);
  });

  it.each([
    // already versioned – must not double-append
    "https://generativelanguage.googleapis.com/v1beta",
    "https://generativelanguage.googleapis.com/v1beta/",
    "https://generativelanguage.googleapis.com/v1alpha",
    "https://generativelanguage.googleapis.com/v2beta",
  ])("leaves already-versioned googleapis.com URL unchanged: %s", (url) => {
    expect(normalizeGoogleBaseUrl(url)).toBe(url.replace(/\/+$/, ""));
  });

  it.each([
    // custom proxy without googleapis domain – leave completely as-is,
    // including any trailing slashes
    "https://my-proxy.example.com/gemini",
    "https://my-proxy.example.com/gemini/",
    "https://openai.example.com/v1",
    "http://localhost:4000",
    // look-alike domain must not be treated as canonical googleapis
    "https://generativelanguage.googleapis.com.evil.com",
  ])("does not modify non-googleapis base URLs: %s", (url) => {
    expect(normalizeGoogleBaseUrl(url)).toBe(url);
  });
});

describe("google provider baseUrl normalization via normalizeProviders", () => {
  function buildModel(id: string): NonNullable<ProviderConfig["models"]>[number] {
    return {
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1048576,
      maxTokens: 65536,
    };
  }

  it("appends /v1beta when google provider baseUrl omits version path (#41276)", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = {
      google: {
        baseUrl: "https://generativelanguage.googleapis.com",
        api: "google-generative-ai",
        apiKey: "GEMINI_KEY",
        models: [buildModel("gemini-3.1-flash-lite-preview")],
      } satisfies ProviderConfig,
    };

    const normalized = normalizeProviders({ providers, agentDir });

    expect(normalized?.google?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("preserves existing /v1beta in google provider baseUrl", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = {
      google: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        api: "google-generative-ai",
        apiKey: "GEMINI_KEY",
        models: [buildModel("gemini-3.1-flash-lite-preview")],
      } satisfies ProviderConfig,
    };

    const normalized = normalizeProviders({ providers, agentDir });

    expect(normalized?.google?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("does not modify baseUrl for non-google providers", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        api: "openai-responses",
        apiKey: "OPENAI_KEY",
        models: [buildModel("gpt-5")],
      } satisfies ProviderConfig,
    };

    const normalized = normalizeProviders({ providers, agentDir });

    expect(normalized?.openai?.baseUrl).toBe("https://api.openai.com/v1");
  });
});
