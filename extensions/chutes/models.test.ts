import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildChutesProvider } from "./api.js";
import { CHUTES_MODEL_CATALOG, discoverChutesModels } from "./models.js";
import {
  applyChutesConfig,
  applyChutesProviderConfig,
  CHUTES_DEFAULT_MODEL_REF,
} from "./onboard.js";

function discoverRows(data: unknown[]) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data })));
  return discoverChutesModels("fixture-discovery-token");
}

function readAuthorizationHeader(init?: { headers?: HeadersInit }): string {
  return new Headers(init?.headers).get("authorization") ?? "";
}

describe("chutes-models", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(["replace"] as const)(
    "keeps catalog ownership, defaults, and aliases aligned in %s mode",
    (mode) => {
      const runtimeIds = new Set(CHUTES_MODEL_CATALOG.map((model) => model.id));
      expect(
        CHUTES_MODEL_CATALOG.every((model) => model.compat?.supportsUsageInStreaming === false),
      ).toBe(true);
      const cfg = applyChutesConfig({ models: { mode } });
      expect(cfg.models?.mode).toBe("replace");
      expect(cfg.models?.providers?.chutes?.models).toEqual(CHUTES_MODEL_CATALOG);
      expect(cfg.agents?.defaults?.model).toEqual({
        primary: "chutes/zai-org/GLM-5.2-TEE",
        fallbacks: ["chutes/deepseek-ai/DeepSeek-V3.2-TEE", "chutes/moonshotai/Kimi-K2.6-TEE"],
      });
      expect(cfg.agents?.defaults?.imageModel).toEqual({
        primary: "chutes/moonshotai/Kimi-K2.6-TEE",
        fallbacks: ["chutes/Qwen/Qwen3.6-27B-TEE"],
      });
      expect(cfg.agents?.defaults?.models?.["chutes-fast"]).toBeUndefined();
      expect(cfg.agents?.defaults?.models?.["chutes-pro"]?.alias).toBe(
        "chutes/deepseek-ai/DeepSeek-V3.2-TEE",
      );
      expect(cfg.agents?.defaults?.models?.["chutes-vision"]?.alias).toBe(
        "chutes/moonshotai/Kimi-K2.6-TEE",
      );
      const catalogBackedTargets = [
        CHUTES_DEFAULT_MODEL_REF,
        "chutes/deepseek-ai/DeepSeek-V3.2-TEE",
        "chutes/moonshotai/Kimi-K2.6-TEE",
        "chutes/Qwen/Qwen3.6-27B-TEE",
      ];
      expect(
        catalogBackedTargets.every((modelRef) => runtimeIds.has(modelRef.slice("chutes/".length))),
      ).toBe(true);
    },
  );

  it("preserves authored zero prices, aliases, and selections without adding merge-mode pins", () => {
    const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const config = applyChutesProviderConfig({});
    const [seed] = CHUTES_MODEL_CATALOG;
    if (!seed) {
      throw new Error("expected a Chutes seed model");
    }
    const model = { ...structuredClone(seed), id: "fixture-provider/authored-model", cost };
    config.models!.providers!.chutes!.models = [model];
    config.models!.providers!.chutes!.apiKey = "fixture-key";
    config.agents!.defaults!.model = {
      primary: "chutes/fixture-provider/authored-model",
      fallbacks: ["fixture-provider/fallback"],
    };
    config.agents!.defaults!.imageModel = {
      primary: "fixture-provider/image-model",
      fallbacks: ["fixture-provider/image-fallback"],
    };
    config.agents!.defaults!.models!["chutes/fixture-provider/authored-model"] = {
      alias: "My authored model",
    };
    config.agents!.defaults!.models!["chutes-pro"] = { alias: "My pro alias" };

    const reapplied = applyChutesProviderConfig(config);

    expect(reapplied.models?.providers?.chutes?.models).toEqual([model]);
    expect(reapplied.models?.providers?.chutes?.apiKey).toBe("fixture-key");
    expect(reapplied.agents?.defaults).toEqual(config.agents?.defaults);
  });

  it("preserves native per-million prices and exact zero rates during discovery", async () => {
    const models = await discoverRows([
      {
        id: "fixture-provider/zero-input",
        pricing: { prompt: 0, completion: 0.2, input_cache_read: 0 },
      },
      {
        id: "new-provider/new-model-r1",
        supported_features: ["reasoning"],
        input_modalities: ["text", "image"],
        context_length: 200000,
        max_output_length: 16384,
        pricing: { prompt: 0.1, completion: 0.2, input_cache_read: 0.05 },
      },
      {
        id: "fixture-provider/free-model",
        pricing: { prompt: 0, completion: 0, input_cache_read: 0 },
      },
    ]);
    expect(models).toHaveLength(3);
    expect(models[0]).toMatchObject({
      id: "fixture-provider/zero-input",
      cost: { input: 0, output: 0.2, cacheRead: 0, cacheWrite: 0 },
    });
    expect(models[2]?.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(models[1]).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 200000,
      maxTokens: 16384,
      compat: { supportsUsageInStreaming: false },
    });
    expect(models[1]?.cost).toEqual({
      input: 0.1,
      output: 0.2,
      cacheRead: 0.05,
      cacheWrite: 0,
    });
  });

  it("scopes discovery cache by access token", async () => {
    const mockFetch = vi.fn().mockImplementation((_url, init?: { headers?: HeadersInit }) => {
      const auth = readAuthorizationHeader(init);
      if (auth === "Bearer chutes-token-a") {
        return Promise.resolve(
          Response.json({
            data: [{ id: "private/model-a" }],
          }),
        );
      }
      if (auth === "Bearer chutes-token-b") {
        return Promise.resolve(
          Response.json({
            data: [{ id: "private/model-b" }],
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          data: [{ id: "public/model" }],
        }),
      );
    });
    vi.stubGlobal("fetch", mockFetch);
    const modelsA = await discoverChutesModels("chutes-token-a");
    const modelsB = await discoverChutesModels("chutes-token-b");
    const modelsASecond = await discoverChutesModels("chutes-token-a");
    expect(modelsA[0]?.id).toBe("private/model-a");
    expect(modelsB[0]?.id).toBe("private/model-b");
    expect(modelsASecond[0]?.id).toBe("private/model-a");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not replace rejected account discovery with an anonymous catalog", async () => {
    const mockFetch = vi.fn().mockImplementation((_url, init?: { headers?: HeadersInit }) => {
      if (readAuthorizationHeader(init) === "Bearer failed-token") {
        return Promise.resolve(new Response("", { status: 401 }));
      }
      return Promise.resolve(
        Response.json({
          data: [{ id: "public/model" }],
        }),
      );
    });
    vi.stubGlobal("fetch", mockFetch);
    await expect(
      discoverChutesModels("failed-token", { discoveryMode: "strict" }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(buildChutesProvider("failed-token")).resolves.toMatchObject({
      models: [{ id: "public/model" }],
    });
    expect(mockFetch.mock.calls.map(([, init]) => readAuthorizationHeader(init))).toEqual([
      "Bearer failed-token",
      "Bearer failed-token",
      "",
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
