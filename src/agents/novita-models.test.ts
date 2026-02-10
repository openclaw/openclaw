import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverNovitaModels,
  NOVITA_MODEL_CATALOG,
  resetNovitaDiscoveryCacheForTest,
} from "./novita-models.js";

function withDiscoveryEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousVitest = process.env.VITEST;
  const previousNodeEnv = process.env.NODE_ENV;
  delete process.env.VITEST;
  delete process.env.NODE_ENV;
  return run().finally(() => {
    if (previousVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = previousVitest;
    }
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });
}

describe("novita model discovery", () => {
  beforeEach(() => {
    resetNovitaDiscoveryCacheForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetNovitaDiscoveryCacheForTest();
  });

  it("falls back to static catalog in test environment", async () => {
    const models = await discoverNovitaModels({ apiKey: "test-key" });
    expect(models).toHaveLength(NOVITA_MODEL_CATALOG.length);
    expect(models[0]?.id).toBe(NOVITA_MODEL_CATALOG[0]?.id);
  });

  it("discovers models from API and preserves metadata for known ids", async () => {
    await withDiscoveryEnv(async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "moonshotai/kimi-k2.5",
              name: "Kimi K2.5 API Name",
              context_size: 262144,
              max_output_tokens: 262144,
              input_token_price_per_m: 1200,
              output_token_price_per_m: 4800,
              model_type: "chat",
            },
            {
              id: "example/reasoning-model",
              display_name: "Reasoning Model",
              context_size: 123456,
              max_output_tokens: 4096,
              input_token_price_per_m: 700,
              output_token_price_per_m: 4000,
              model_type: "chat",
              features: ["vision", "serverless"],
            },
          ],
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const models = await discoverNovitaModels({ apiKey: "test-key", useCache: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const known = models.find((model) => model.id === "moonshotai/kimi-k2.5");
      expect(known).toBeDefined();
      expect(known?.input).toEqual(["text", "image"]);
      expect(known?.reasoning).toBe(true);
      expect(known?.cost.input).toBe(1200);
      expect(known?.cost.output).toBe(4800);
      expect(known?.contextWindow).toBe(262144);
      expect(known?.maxTokens).toBe(262144);

      const discovered = models.find((model) => model.id === "example/reasoning-model");
      expect(discovered).toBeDefined();
      expect(discovered?.name).toBe("Reasoning Model");
      expect(discovered?.input).toEqual(["text", "image"]);
      expect(discovered?.reasoning).toBe(true);
      expect(discovered?.cost.input).toBe(700);
      expect(discovered?.cost.output).toBe(4000);
      expect(discovered?.contextWindow).toBe(123456);
      expect(discovered?.maxTokens).toBe(4096);
    });
  });

  it("uses cache between calls and falls back to static catalog on API failure", async () => {
    await withDiscoveryEnv(async () => {
      const successFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "moonshotai/kimi-k2.5" }] }),
      });
      vi.stubGlobal("fetch", successFetch);

      await discoverNovitaModels({ apiKey: "test-key" });
      await discoverNovitaModels({ apiKey: "test-key" });
      expect(successFetch).toHaveBeenCalledTimes(1);

      const failedFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });
      vi.stubGlobal("fetch", failedFetch);
      resetNovitaDiscoveryCacheForTest();

      const fallback = await discoverNovitaModels({ apiKey: "test-key", useCache: false });
      expect(fallback).toHaveLength(NOVITA_MODEL_CATALOG.length);
      expect(fallback[0]?.id).toBe(NOVITA_MODEL_CATALOG[0]?.id);
    });
  });
});
