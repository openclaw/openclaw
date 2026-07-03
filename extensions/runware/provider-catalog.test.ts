// Runware tests cover provider catalog discovery and fallback behavior.
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNWARE_FALLBACK_MODELS } from "./models.js";
import {
  buildRunwareProvider,
  buildStaticRunwareProvider,
  discoverRunwareModels,
} from "./provider-catalog.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Real /v1/models responses are wrapped as { object: "list", data: [...] },
// not a bare array.
function modelsListResponse(rows: unknown[], status = 200): Response {
  return jsonResponse({ object: "list", data: rows }, status);
}

afterEach(() => {
  clearLiveCatalogCacheForTests();
  vi.unstubAllGlobals();
});

describe("discoverRunwareModels", () => {
  it("maps a real { object, data } /v1/models response into full model definitions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        modelsListResponse([
          {
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            context_length: 128000,
            max_output_tokens: 65536,
            input_modalities: ["text"],
            pricing: { prompt: "0.000001", completion: "0.000002" },
          },
        ]),
      ) as unknown as typeof fetch,
    );

    const models = await discoverRunwareModels("test-key");
    expect(models).toEqual([
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 65536,
      },
    ]);
  });

  it("falls back to the illustrative catalog on HTTP failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401)) as unknown as typeof fetch,
    );

    const models = await discoverRunwareModels("bad-key");
    expect(models).toBe(RUNWARE_FALLBACK_MODELS);
  });

  it("falls back to the illustrative catalog when the response has no usable rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => modelsListResponse([{ name: "missing id" }])) as unknown as typeof fetch,
    );

    const models = await discoverRunwareModels("test-key");
    expect(models).toBe(RUNWARE_FALLBACK_MODELS);
  });
});

describe("buildRunwareProvider", () => {
  it("builds a provider config pointed at the Runware base URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        modelsListResponse([{ id: "deepseek-v4-flash" }]),
      ) as unknown as typeof fetch,
    );

    const provider = await buildRunwareProvider("test-key");
    expect(provider.baseUrl).toBe("https://api.runware.ai/v1");
    expect(provider.api).toBe("openai-completions");
    expect(provider.models).toHaveLength(1);
  });
});

describe("buildStaticRunwareProvider", () => {
  it("returns the offline catalog without any network access", () => {
    const provider = buildStaticRunwareProvider();
    expect(provider.models).toBe(RUNWARE_FALLBACK_MODELS);
  });
});
