import { describe, expect, it } from "vitest";
import {
  isGoogleVertexBaseUrl,
  isGoogleVertexHostname,
  normalizeGoogleApiBaseUrl,
  normalizeGoogleGenerativeAiBaseUrl as normalizeBaseUrl,
  normalizeGoogleProviderConfig,
  resolveGoogleGenerativeAiHttpRequestConfig as requestConfig,
  resolveGoogleGenerativeAiApiOrigin,
  resolveGoogleGenerativeAiTransport as resolveTransport,
  shouldNormalizeGoogleGenerativeAiProviderConfig as shouldNormalize,
} from "./api.js";

const origin = "https://generativelanguage.googleapis.com";
const vertexOpenAi =
  "https://aiplatform.googleapis.com/v1/projects/test/locations/us-central1/endpoints/openapi";

describe("google generative ai helpers", () => {
  it("normalizes only explicit Google Generative AI baseUrls", () => {
    expect(normalizeBaseUrl(origin)).toBe(`${origin}/v1beta`);
    for (const url of [
      "https://proxy.example.com/google/v1beta",
      "https://aiplatform.googleapis.com",
      "proxy/generativelanguage.googleapis.com",
      "https://xgenerativelanguage.googleapis.com",
    ]) {
      expect(normalizeBaseUrl(url)).toBe(url);
    }
    for (const url of ["   ", undefined]) {
      expect(normalizeBaseUrl(url)).toBeUndefined();
    }
  });

  it.each(["v1beta", "v1alpha"])("strips /openai only for native %s callers", (version) => {
    const baseUrl = `${origin}/${version}`;
    expect(normalizeGoogleApiBaseUrl(`${baseUrl}/openai/`)).toBe(`${baseUrl}/openai`);
    expect(normalizeBaseUrl(`${baseUrl}/openai/`)).toBe(baseUrl);
  });

  it("normalizes Google provider configs by provider key, provider api, or model api", () => {
    const models = [{ api: "openai-completions" }];
    const cases = [
      ["google", { models }, true],
      ["custom", { api: "google-generative-ai", models }, true],
      ["custom", { models: [{ api: "google-generative-ai" }] }, true],
      ["custom", { api: "openai-completions", models }, false],
      ["google", { api: "openai-completions", models }, false],
      ["google-vertex", { baseUrl: "https://aiplatform.googleapis.com" }, false],
    ] as const;
    for (const [provider, config, expected] of cases) {
      expect(shouldNormalize(provider, config)).toBe(expected);
    }
  });

  it("detects native Google Vertex hosts by hostname only", () => {
    for (const [host, expected] of [
      ["aiplatform.googleapis.com", true],
      ["us-central1-aiplatform.googleapis.com", true],
      ["generativelanguage.googleapis.com", false],
      ["evil-aiplatform.googleapis.com.attacker.com", false],
    ] as const) {
      expect(isGoogleVertexHostname(host)).toBe(expected);
    }
    expect(isGoogleVertexBaseUrl(`${origin}/v1beta/proxy/aiplatform.googleapis.com`)).toBe(false);
  });

  it("normalizes transport baseUrls only for Google Generative AI", () => {
    const vertex = "https://us-central1-aiplatform.googleapis.com";
    const cases = [
      ["google", undefined, origin, "google-generative-ai", `${origin}/v1beta`],
      [undefined, "google-generative-ai", origin, "google-generative-ai", `${origin}/v1beta`],
      [undefined, "openai-completions", origin, "openai-completions", origin],
      ["google-vertex", undefined, vertex, "google-vertex", vertex],
      ["google-vertex", "openai-completions", vertexOpenAi, "openai-completions", vertexOpenAi],
    ] as const;
    for (const [provider, api, baseUrl, expectedApi, expectedUrl] of cases) {
      expect(resolveTransport({ provider, api, baseUrl })).toEqual({
        api: expectedApi,
        baseUrl: expectedUrl,
      });
    }
  });

  it("normalizes google-vertex model ids without rewriting the OpenAI-compatible baseUrl", () => {
    const config: Parameters<typeof normalizeGoogleProviderConfig>[1] = {
      api: "openai-completions",
      baseUrl: vertexOpenAi,
      models: [
        {
          id: "gemini-3.1-flash-lite",
          name: "Gemini Flash Lite",
          input: ["text" as const],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1,
          maxTokens: 1,
        },
      ],
    };
    const expected = structuredClone(config);
    expect(normalizeGoogleProviderConfig("google-vertex", config)).toEqual(expected);
  });

  it("derives the Gemini API origin without duplicating /v1beta", () => {
    for (const url of [undefined, origin, `${origin}/v1beta`]) {
      expect(resolveGoogleGenerativeAiApiOrigin(url)).toBe(origin);
    }
  });

  it.each([
    [JSON.stringify({ token: "oauth-token" }), { authorization: "Bearer oauth-token" }],
    ["api-key-123", { "x-goog-api-key": "api-key-123" }],
  ] as const)("builds shared HTTP auth for %s", (apiKey, auth) => {
    const config = requestConfig({ apiKey, capability: "image", transport: "http" });
    expect(config).toMatchObject({ baseUrl: `${origin}/v1beta`, allowPrivateNetwork: false });
    expect(Object.fromEntries(new Headers(config.headers).entries())).toMatchObject({
      ...auth,
      "content-type": "application/json",
      "x-goog-api-client": expect.stringMatching(/^openclaw\//u),
    });
  });

  it("strips URL credentials during Google base URL normalization", () => {
    expect(
      normalizeGoogleApiBaseUrl(
        "https://user:secret@generativelanguage.googleapis.com/v1beta/openai?x=1#frag",
      ),
    ).toBe(`${origin}/v1beta/openai`);
  });

  it("rejects non-Google Gemini base URLs and honors explicit private-network opt-in", () => {
    const request = { apiKey: "api-key-123", capability: "image", transport: "http" } as const;
    for (const baseUrl of [
      "https://proxy.example.com/v1beta",
      "http://generativelanguage.googleapis.com/v1beta",
    ]) {
      expect(() => requestConfig({ ...request, baseUrl })).toThrow(
        "Google Generative AI baseUrl must use https://generativelanguage.googleapis.com",
      );
    }
    expect(
      requestConfig({ ...request, request: { allowPrivateNetwork: true } }).allowPrivateNetwork,
    ).toBe(true);
  });
});
