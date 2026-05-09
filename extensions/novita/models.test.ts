import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOVITA_MODEL_CATALOG,
  buildNovitaModelDefinition,
  clearNovitaModelCacheForTests,
  discoverNovitaModels,
} from "./models.js";

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function withLiveNovitaDiscovery<T>(
  fetchMock: ReturnType<typeof vi.fn>,
  run: () => Promise<T>,
): Promise<T> {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldVitest = process.env.VITEST;
  delete process.env.NODE_ENV;
  delete process.env.VITEST;
  vi.stubGlobal("fetch", fetchMock);

  try {
    return await run();
  } finally {
    restoreEnvVar("NODE_ENV", oldNodeEnv);
    restoreEnvVar("VITEST", oldVitest);
    vi.unstubAllGlobals();
  }
}

function requireNovitaModel(
  models: Awaited<ReturnType<typeof discoverNovitaModels>>,
  index: number,
): Awaited<ReturnType<typeof discoverNovitaModels>>[number] {
  const model = models[index];
  if (!model) {
    throw new Error(`expected Novita model at index ${index}`);
  }
  return model;
}

describe("novita-models", () => {
  beforeEach(() => {
    clearNovitaModelCacheForTests();
  });

  it("buildNovitaModelDefinition returns static curated model fields", () => {
    const entry = NOVITA_MODEL_CATALOG[0];
    const def = buildNovitaModelDefinition(entry);

    expect(def).toEqual({
      id: entry.id,
      name: entry.name,
      reasoning: entry.reasoning,
      input: entry.input,
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      cost: entry.cost,
      compat: {
        supportsUsageInStreaming: true,
        maxTokensField: "max_tokens",
      },
    });
  });

  it("discoverNovitaModels maps Novita /models fields", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "vendor/vision-reasoner",
            display_name: "Vision Reasoner",
            input_modalities: ["text", "image"],
            context_size: 200000,
            max_output_tokens: 64000,
            features: ["reasoning"],
            input_token_price_per_m: 1230,
            output_token_price_per_m: 4560,
          },
        ],
      }),
    });

    await withLiveNovitaDiscovery(mockFetch, async () => {
      const models = await discoverNovitaModels("novita-token");
      const model = requireNovitaModel(models, 0);
      expect(model).toMatchObject({
        id: "vendor/vision-reasoner",
        name: "Vision Reasoner",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 200000,
        maxTokens: 64000,
        cost: {
          input: 1.23,
          output: 4.56,
          cacheRead: 0,
          cacheWrite: 0,
        },
        compat: {
          supportsUsageInStreaming: true,
          maxTokensField: "max_tokens",
        },
      });
    });
  });

  it("discoverNovitaModels falls back to curated static catalog when discovery fails", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    });

    await withLiveNovitaDiscovery(mockFetch, async () => {
      const models = await discoverNovitaModels("novita-token");
      expect(models.map((model) => model.id)).toEqual(
        NOVITA_MODEL_CATALOG.map((model) => model.id),
      );
    });
  });
});
