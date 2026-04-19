import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEEPINFRA_DEFAULT_MODEL_REF,
  DEEPINFRA_MODELS_URL,
  discoverDeepInfraModels,
  resetDeepInfraModelCacheForTest,
  resolveDeepInfraDefaultModelRef,
} from "./provider-models.js";

beforeEach(() => {
  resetDeepInfraModelCacheForTest();
});

function makeModelEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "openai/gpt-oss-120b",
    object: "model",
    owned_by: "deepinfra",
    metadata: {
      description: "A powerful model",
      context_length: 131072,
      max_tokens: 131072,
      pricing: {
        input_tokens: 3.0,
        output_tokens: 15.0,
        cache_read_tokens: 0.3,
      },
      tags: ["vision", "reasoning_effort", "prompt_cache", "reasoning"],
    },
    ...overrides,
  };
}

function makeTextOnlyEntry(overrides: Record<string, unknown> = {}) {
  return makeModelEntry({
    id: "minimaxai/minimax-m2.5",
    metadata: {
      description: "Text only model",
      context_length: 196608,
      max_tokens: 196608,
      pricing: {
        input_tokens: 1.0,
        output_tokens: 2.0,
      },
      tags: [],
    },
    ...overrides,
  });
}

async function withFetchPathTest(
  mockFetch: ReturnType<typeof vi.fn>,
  runAssertions: () => Promise<void>,
) {
  const origNodeEnv = process.env.NODE_ENV;
  const origVitest = process.env.VITEST;
  delete process.env.NODE_ENV;
  delete process.env.VITEST;

  vi.stubGlobal("fetch", mockFetch);

  try {
    await runAssertions();
  } finally {
    if (origNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = origNodeEnv;
    }
    if (origVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = origVitest;
    }
    vi.unstubAllGlobals();
  }
}

describe("discoverDeepInfraModels", () => {
  it("returns static catalog in test environment", async () => {
    const models = await discoverDeepInfraModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.id === "stepfun-ai/Step-3.5-Flash")).toBe(true);
  });

  it("static catalog has correct defaults for default model", async () => {
    const models = await discoverDeepInfraModels();
    const defaultModel = models.find((m) => m.id === "zai-org/GLM-5.1");
    expect(defaultModel).toBeDefined();
    expect(defaultModel?.name).toBe("GLM-5.1");
    expect(defaultModel?.reasoning).toBe(true);
    expect(defaultModel?.input).toEqual(["text"]);
    expect(defaultModel?.contextWindow).toBe(202752);
    expect(defaultModel?.maxTokens).toBe(202752);
    expect(defaultModel?.cost).toBeDefined();
    expect(defaultModel?.cost?.input).not.toBe(0);
    expect(defaultModel?.cost?.output).not.toBe(0);
    expect(defaultModel?.cost?.cacheRead).not.toBe(0);
    expect(defaultModel?.cost?.cacheWrite).toBe(0);
  });
});

describe("discoverDeepInfraModels (fetch path)", () => {
  it("fetches from the correct URL with Accept header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [makeModelEntry()] }),
    });
    await withFetchPathTest(mockFetch, async () => {
      await discoverDeepInfraModels();
      expect(mockFetch).toHaveBeenCalledWith(
        DEEPINFRA_MODELS_URL,
        expect.objectContaining({
          headers: { Accept: "application/json" },
        }),
      );
    });
  });

  it("parses model pricing correctly", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [makeModelEntry()] }),
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverDeepInfraModels();
      const model = models.find((m) => m.id === "openai/gpt-oss-120b");
      expect(model).toBeDefined();
      expect(model?.cost.input).toBeCloseTo(3.0);
      expect(model?.cost.output).toBeCloseTo(15.0);
      expect(model?.cost.cacheRead).toBeCloseTo(0.3);
      expect(model?.cost.cacheWrite).toBe(0);
    });
  });

  it("detects vision models with image modality", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [makeModelEntry()] }),
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverDeepInfraModels();
      const model = models.find((m) => m.id === "openai/gpt-oss-120b");
      expect(model?.input).toEqual(["text", "image"]);
    });
  });

  it("detects text-only models without image modality", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [makeTextOnlyEntry()] }),
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverDeepInfraModels();
      const model = models.find((m) => m.id === "minimaxai/minimax-m2.5");
      expect(model?.input).toEqual(["text"]);
    });
  });

  it("detects reasoning models via reasoning_effort tag", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [makeModelEntry(), makeTextOnlyEntry()] }),
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverDeepInfraModels();
      expect(models.find((m) => m.id === "openai/gpt-oss-120b")?.reasoning).toBe(true);
      expect(models.find((m) => m.id === "minimaxai/minimax-m2.5")?.reasoning).toBe(false);
    });
  });

  it("uses defaults when context_length and max_tokens are missing", async () => {
    const entryNoLimits = makeModelEntry({
      id: "some/model",
      metadata: {
        pricing: { input_tokens: 1, output_tokens: 2 },
        tags: [],
      },
    });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [entryNoLimits] }),
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverDeepInfraModels();
      const model = models.find((m) => m.id === "some/model");
      expect(model?.contextWindow).toBe(128000);
      expect(model?.maxTokens).toBe(8192);
    });
  });

  it("uses zero cost when pricing fields are missing", async () => {
    const entryNoPricing = makeModelEntry({
      id: "some/free-model",
      metadata: {
        context_length: 32000,
        max_tokens: 4096,
        tags: [],
      },
    });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [entryNoPricing] }),
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverDeepInfraModels();
      const model = models.find((m) => m.id === "some/free-model");
      expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    });
  });

  it("skips models with null metadata (embeddings, image-gen, etc.)", async () => {
    const embeddingEntry = { id: "BAAI/bge-m3", object: "model", metadata: null };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [embeddingEntry, makeModelEntry()] }),
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverDeepInfraModels();
      expect(models.some((m) => m.id === "BAAI/bge-m3")).toBe(false);
      expect(models.some((m) => m.id === "openai/gpt-oss-120b")).toBe(true);
    });
  });

  it("does not merge static catalog into discovered models", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [makeModelEntry({ id: "only/discovered-model" })],
        }),
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverDeepInfraModels();
      expect(models).toHaveLength(1);
      expect(models[0]?.id).toBe("only/discovered-model");
      // Static catalog models should NOT be present
      expect(models.some((m) => m.id === "zai-org/GLM-5.1")).toBe(false);
    });
  });

  it("deduplicates models with the same id", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [makeModelEntry(), makeModelEntry()] }),
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverDeepInfraModels();
      const matches = models.filter((m) => m.id === "openai/gpt-oss-120b");
      expect(matches.length).toBe(1);
    });
  });

  it("falls back to static catalog on network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverDeepInfraModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.id === "stepfun-ai/Step-3.5-Flash")).toBe(true);
    });
  });

  it("falls back to static catalog on HTTP error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverDeepInfraModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.id === "stepfun-ai/Step-3.5-Flash")).toBe(true);
    });
  });

  it("falls back to static catalog when response has empty data array", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverDeepInfraModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.id === "stepfun-ai/Step-3.5-Flash")).toBe(true);
    });
  });

  it("falls back to static catalog when all entries have null metadata", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            { id: "BAAI/bge-m3", metadata: null },
            { id: "stabilityai/sdxl", metadata: null },
          ],
        }),
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverDeepInfraModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.id === "stepfun-ai/Step-3.5-Flash")).toBe(true);
    });
  });

  it("falls back to the static catalog when response.json() rejects", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error("malformed JSON")),
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverDeepInfraModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.id === "zai-org/GLM-5.1")).toBe(true);
    });
  });
});

describe("discoverDeepInfraModels (cache)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns cached models on subsequent calls within the TTL window", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [makeModelEntry()] }),
    });
    await withFetchPathTest(mockFetch, async () => {
      const first = await discoverDeepInfraModels();
      const second = await discoverDeepInfraModels();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(first.map((m) => m.id)).toEqual(second.map((m) => m.id));
    });
  });

  it("refetches after resetDeepInfraModelCacheForTest()", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [makeModelEntry()] }),
    });
    await withFetchPathTest(mockFetch, async () => {
      await discoverDeepInfraModels();
      resetDeepInfraModelCacheForTest();
      await discoverDeepInfraModels();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  it("refetches after the 30 min TTL expires", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [makeModelEntry()] }),
    });
    vi.useFakeTimers({ now: 0, toFake: ["Date"] });
    await withFetchPathTest(mockFetch, async () => {
      await discoverDeepInfraModels();
      vi.setSystemTime(30 * 60 * 1000 + 1);
      await discoverDeepInfraModels();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  it("does not poison the cache when discovery fails", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [makeModelEntry()] }),
      });
    await withFetchPathTest(mockFetch, async () => {
      const first = await discoverDeepInfraModels();
      // Failure path returned static catalog — the default model should be present.
      expect(first.some((m) => m.id === "zai-org/GLM-5.1")).toBe(true);

      const second = await discoverDeepInfraModels();
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(second.some((m) => m.id === "openai/gpt-oss-120b")).toBe(true);
    });
  });

  it("does not poison the cache when response has empty data array", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [makeModelEntry()] }),
      });
    await withFetchPathTest(mockFetch, async () => {
      await discoverDeepInfraModels();
      const second = await discoverDeepInfraModels();
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(second.some((m) => m.id === "openai/gpt-oss-120b")).toBe(true);
    });
  });
});

describe("resolveDeepInfraDefaultModelRef", () => {
  it("returns the preferred default when discovery includes it", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            makeModelEntry({ id: "zai-org/GLM-5.1" }),
            makeModelEntry({ id: "openai/gpt-oss-120b" }),
          ],
        }),
    });
    await withFetchPathTest(mockFetch, async () => {
      expect(await resolveDeepInfraDefaultModelRef()).toBe(DEEPINFRA_DEFAULT_MODEL_REF);
    });
  });

  it("falls back to the first discovered model when the preferred default is absent", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            makeModelEntry({ id: "openai/gpt-oss-120b" }),
            makeModelEntry({ id: "moonshotai/Kimi-K2.5" }),
          ],
        }),
    });
    await withFetchPathTest(mockFetch, async () => {
      expect(await resolveDeepInfraDefaultModelRef()).toBe("deepinfra/openai/gpt-oss-120b");
    });
  });

  it("returns the preferred default when discovery fails (static fallback retains it)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network down"));
    await withFetchPathTest(mockFetch, async () => {
      expect(await resolveDeepInfraDefaultModelRef()).toBe(DEEPINFRA_DEFAULT_MODEL_REF);
    });
  });
});

