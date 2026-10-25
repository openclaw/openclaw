import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildChutesProvider } from "./api.js";
import { CHUTES_MODEL_CATALOG, discoverChutesModels } from "./models.js";
import {
  applyChutesConfig,
  applyChutesProviderConfig,
  CHUTES_DEFAULT_MODEL_REF,
} from "./onboard.js";

const primary = "chutes/zai-org/GLM-5.2-TEE";
const pro = "chutes/deepseek-ai/DeepSeek-V3.2-TEE";
const vision = "chutes/moonshotai/Kimi-K2.6-TEE";
const imageFallback = "chutes/Qwen/Qwen3.6-27B-TEE";

const catalog = (data: unknown[]) => Response.json({ data });

function discoverRows(data: unknown[]) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(catalog(data)));
  return discoverChutesModels("fixture-discovery-token");
}

function pricedRow(id: string, prompt: number, completion: number, input_cache_read: number) {
  return { id, pricing: { prompt, completion, input_cache_read } };
}

function authorization(init?: RequestInit): string {
  return new Headers(init?.headers).get("authorization") ?? "";
}

function selection(model: string, fallback: string) {
  return { primary: model, fallbacks: [fallback] };
}

beforeEach(() => clearLiveCatalogCacheForTests());
afterEach(() => vi.unstubAllGlobals());

it("keeps catalog ownership, defaults, and aliases aligned in replace mode", () => {
  expect(
    CHUTES_MODEL_CATALOG.every((model) => model.compat?.supportsUsageInStreaming === false),
  ).toBe(true);
  const cfg = applyChutesConfig({ models: { mode: "replace" } });
  expect(cfg.models?.mode).toBe("replace");
  expect(cfg.models?.providers?.chutes?.models).toEqual(CHUTES_MODEL_CATALOG);
  expect(cfg.agents?.defaults?.models).toMatchObject({
    "chutes-pro": { alias: pro },
    "chutes-vision": { alias: vision },
  });
  expect(cfg.agents?.defaults?.model).toEqual({ primary, fallbacks: [pro, vision] });
  expect(cfg.agents?.defaults?.imageModel).toEqual(selection(vision, imageFallback));
  expect(cfg.agents?.defaults?.models?.["chutes-fast"]).toBeUndefined();
  expect(CHUTES_MODEL_CATALOG.map(({ id }) => `chutes/${id}`)).toEqual(
    expect.arrayContaining([CHUTES_DEFAULT_MODEL_REF, pro, vision, imageFallback]),
  );
});

it("preserves authored zero prices, aliases, and selections without adding merge-mode pins", () => {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const config = applyChutesProviderConfig({});
  const [seed] = CHUTES_MODEL_CATALOG;
  if (!seed) {
    throw new Error("expected a Chutes seed model");
  }
  const id = "fixture/authored";
  const model = { ...structuredClone(seed), id, cost };
  Object.assign(config.models!.providers!.chutes!, { models: [model], apiKey: "fixture-key" });
  Object.assign(config.agents!.defaults!, {
    model: selection(`chutes/${id}`, "fixture/fallback"),
    imageModel: selection("fixture/image", "fixture/image-fallback"),
  });
  Object.assign(config.agents!.defaults!.models!, {
    [`chutes/${id}`]: { alias: "My authored model" },
    "chutes-pro": { alias: "My pro alias" },
  });
  const reapplied = applyChutesProviderConfig(config);
  expect(reapplied.models?.providers?.chutes).toMatchObject({ apiKey: "fixture-key" });
  expect(reapplied.models?.providers?.chutes?.models).toEqual([model]);
  expect(reapplied.agents?.defaults).toEqual(config.agents?.defaults);
});

it("preserves native per-million prices and exact zero rates during discovery", async () => {
  const models = await discoverRows([
    pricedRow("fixture-provider/zero-input", 0, 0.2, 0),
    {
      ...pricedRow("new-provider/new-model-r1", 0.1, 0.2, 0.05),
      supported_features: ["reasoning"],
      input_modalities: ["text", "image"],
      context_length: 200000,
      max_output_length: 16384,
    },
    pricedRow("fixture-provider/free-model", 0, 0, 0),
  ]);
  expect(models).toHaveLength(3);
  expect(models[0]).toMatchObject({
    id: "fixture-provider/zero-input",
    cost: { input: 0, output: 0.2, cacheRead: 0, cacheWrite: 0 },
  });
  expect(models[2]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  expect(models[1]).toMatchObject({
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 16384,
    compat: { supportsUsageInStreaming: false },
  });
  expect(models[1]?.cost).toEqual({ input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0 });
});

it("scopes discovery cache by access token", async () => {
  const modelIds: Record<string, string> = {
    "Bearer chutes-token-a": "private/model-a",
    "Bearer chutes-token-b": "private/model-b",
  };
  const mockFetch = vi.fn(async (_url, init?: RequestInit) => {
    return catalog([{ id: modelIds[authorization(init)] ?? "public/model" }]);
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
  const mockFetch = vi.fn(async (_url, init?: RequestInit) => {
    if (authorization(init) === "Bearer failed-token") {
      return new Response("", { status: 401 });
    }
    return catalog([{ id: "public/model" }]);
  });
  vi.stubGlobal("fetch", mockFetch);
  await expect(
    discoverChutesModels("failed-token", { discoveryMode: "strict" }),
  ).rejects.toMatchObject({ status: 401 });
  await expect(buildChutesProvider("failed-token")).resolves.toMatchObject({
    models: [{ id: "public/model" }],
  });
  expect(mockFetch.mock.calls.map(([, init]) => authorization(init))).toEqual([
    "Bearer failed-token",
    "Bearer failed-token",
    "",
  ]);
});
