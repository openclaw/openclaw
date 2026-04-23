import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAzureOpenAIImageRoute, isAzureOpenAIBaseUrl } from "./azure.js";

describe("isAzureOpenAIBaseUrl", () => {
  it("recognizes the Azure host suffixes we route through", () => {
    expect(isAzureOpenAIBaseUrl("https://foo.openai.azure.com")).toBe(true);
    expect(isAzureOpenAIBaseUrl("https://foo.services.ai.azure.com")).toBe(true);
    expect(isAzureOpenAIBaseUrl("https://foo.cognitiveservices.azure.com")).toBe(true);
  });

  it("returns false for public OpenAI and other hosts", () => {
    expect(isAzureOpenAIBaseUrl(undefined)).toBe(false);
    expect(isAzureOpenAIBaseUrl("")).toBe(false);
    expect(isAzureOpenAIBaseUrl("https://api.openai.com/v1")).toBe(false);
    expect(isAzureOpenAIBaseUrl("not a url")).toBe(false);
  });
});

describe("buildAzureOpenAIImageRoute", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds the deployment-scoped URL and api-key header from a bare endpoint", () => {
    const route = buildAzureOpenAIImageRoute({
      baseUrl: "https://x.openai.azure.com",
      deployment: "gpt-image-2",
      apiKey: "k",
      operation: "generations",
      apiVersion: "2024-10-21",
    });

    expect(route.url).toBe(
      "https://x.openai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2024-10-21",
    );
    expect(route.headers).toEqual({ "api-key": "k" });
  });

  it("trims trailing slashes on a bare endpoint", () => {
    const route = buildAzureOpenAIImageRoute({
      baseUrl: "https://x.openai.azure.com///",
      deployment: "foo",
      apiKey: "k",
      operation: "generations",
      apiVersion: "2024-10-21",
    });

    expect(route.url).toBe(
      "https://x.openai.azure.com/openai/deployments/foo/images/generations?api-version=2024-10-21",
    );
  });

  it("strips a trailing `/openai/v1` suffix that onboarding appends to the baseUrl", () => {
    // Standard OpenClaw onboarding stores the Azure baseUrl as
    // `https://<endpoint>/openai/v1`. The deployment path must be appended to
    // the endpoint origin, not to the `/openai/v1` suffix, or the call 404s.
    const route = buildAzureOpenAIImageRoute({
      baseUrl: "https://x.openai.azure.com/openai/v1",
      deployment: "foo",
      apiKey: "k",
      operation: "generations",
      apiVersion: "2024-10-21",
    });

    expect(route.url).toBe(
      "https://x.openai.azure.com/openai/deployments/foo/images/generations?api-version=2024-10-21",
    );
  });

  it("strips a trailing `/openai/v1/` suffix (with trailing slash) too", () => {
    const route = buildAzureOpenAIImageRoute({
      baseUrl: "https://x.openai.azure.com/openai/v1/",
      deployment: "foo",
      apiKey: "k",
      operation: "edits",
      apiVersion: "2024-10-21",
    });

    expect(route.url).toBe(
      "https://x.openai.azure.com/openai/deployments/foo/images/edits?api-version=2024-10-21",
    );
  });

  it("strips a bare `/openai` suffix", () => {
    const route = buildAzureOpenAIImageRoute({
      baseUrl: "https://x.openai.azure.com/openai",
      deployment: "foo",
      apiKey: "k",
      operation: "generations",
      apiVersion: "2024-10-21",
    });

    expect(route.url).toBe(
      "https://x.openai.azure.com/openai/deployments/foo/images/generations?api-version=2024-10-21",
    );
  });

  it("url-encodes the deployment name and api-version", () => {
    const route = buildAzureOpenAIImageRoute({
      baseUrl: "https://x.openai.azure.com",
      deployment: "dep/with space",
      apiKey: "k",
      operation: "generations",
      apiVersion: "2024-10-21",
    });

    expect(route.url).toBe(
      "https://x.openai.azure.com/openai/deployments/dep%2Fwith%20space/images/generations?api-version=2024-10-21",
    );
  });

  it("falls back to the default api-version when none is supplied", () => {
    const route = buildAzureOpenAIImageRoute({
      baseUrl: "https://x.openai.azure.com",
      deployment: "foo",
      apiKey: "k",
      operation: "generations",
    });

    expect(route.url).toContain("api-version=2024-12-01-preview");
  });

  it("honors AZURE_OPENAI_API_VERSION env as the default", () => {
    vi.stubEnv("AZURE_OPENAI_API_VERSION", "2025-01-01-preview");
    const route = buildAzureOpenAIImageRoute({
      baseUrl: "https://x.openai.azure.com",
      deployment: "foo",
      apiKey: "k",
      operation: "generations",
    });

    expect(route.url).toContain("api-version=2025-01-01-preview");
  });

  it("ignores query/fragment on the base URL so api-version stays the only query", () => {
    const route = buildAzureOpenAIImageRoute({
      baseUrl: "https://x.openai.azure.com/openai/v1?tenant=t#frag",
      deployment: "foo",
      apiKey: "k",
      operation: "generations",
      apiVersion: "2024-10-21",
    });

    expect(route.url).toBe(
      "https://x.openai.azure.com/openai/deployments/foo/images/generations?api-version=2024-10-21",
    );
  });
});
