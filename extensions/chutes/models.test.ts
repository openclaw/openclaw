import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildChutesProvider } from "./api.js";
import { CHUTES_MODEL_CATALOG as chutesCatalog, discoverChutesModels } from "./models.js";
import { applyChutesConfig, applyChutesProviderConfig } from "./onboard.js";

const primary = "chutes/zai-org/GLM-5.2-TEE";
const pro = "chutes/deepseek-ai/DeepSeek-V3.2-TEE";
const vision = "chutes/moonshotai/Kimi-K2.6-TEE";
const imageFallback = "chutes/Qwen/Qwen3.6-27B-TEE";

const catalog = (data: unknown[]) => Response.json({ data });
const authorization = (init?: RequestInit) => new Headers(init?.headers).get("authorization") ?? "";
const selection = (model: string, fallback: string) => ({ primary: model, fallbacks: [fallback] });

function discoverRows(data: unknown[]) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(catalog(data)));
  return discoverChutesModels("fixture-discovery-token");
}

beforeEach(() => clearLiveCatalogCacheForTests());
afterEach(() => vi.unstubAllGlobals());

it("keeps catalog ownership, defaults, and aliases aligned in replace mode", () => {
  chutesCatalog.forEach((model) => expect(model.compat?.supportsUsageInStreaming).toBe(false));
  const cfg = applyChutesConfig({ models: { mode: "replace" } });
  expect(cfg.models?.mode).toBe("replace");
  expect(cfg.models?.providers?.chutes?.models).toEqual(chutesCatalog);
  expect(cfg.agents?.defaults?.models).toMatchObject({
    "chutes-pro": { alias: pro },
    "chutes-vision": { alias: vision },
  });
  expect(cfg.agents?.defaults?.model).toEqual({ primary, fallbacks: [pro, vision] });
  expect(cfg.agents?.defaults?.imageModel).toEqual(selection(vision, imageFallback));
  expect(cfg.agents?.defaults?.models?.["chutes-fast"]).toBeUndefined();
  expect(chutesCatalog.map(({ id }) => `chutes/${id}`)).toEqual(
    expect.arrayContaining([primary, pro, vision, imageFallback]),
  );
});

it("preserves authored zero prices, aliases, and selections without adding merge-mode pins", () => {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const config = applyChutesProviderConfig({});
  const id = "fixture/authored";
  const models = structuredClone(chutesCatalog.slice(0, 1));
  expect(models).toHaveLength(1);
  models.forEach((model) => Object.assign(model, { id, cost }));
  Object.assign(config.models!.providers!.chutes!, { models, apiKey: "fixture-key" });
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
  expect(reapplied.models?.providers?.chutes?.models).toEqual(models);
  expect(reapplied.agents?.defaults).toEqual(config.agents?.defaults);
});

it("preserves native per-million prices and exact zero rates during discovery", async () => {
  const models = await discoverRows([
    { id: "fixture/free", pricing: { prompt: 0, completion: 0, input_cache_read: 0 } },
    {
      id: "fixture/model-r1",
      pricing: { prompt: 0.1, completion: 0.2, input_cache_read: 0.05 },
      supported_features: ["reasoning"],
      input_modalities: ["text", "image"],
      context_length: 200000,
      max_output_length: 16384,
    },
  ]);
  expect(models.map(({ cost }) => cost)).toEqual([
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    { input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0 },
  ]);
  expect(models[1]).toMatchObject({
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 16384,
    compat: { supportsUsageInStreaming: false },
  });
});

it("scopes discovery cache by access token", async () => {
  const modelIds: Record<string, string> = {
    "Bearer a": "private/a",
    "Bearer b": "private/b",
  };
  const mockFetch = vi.fn(async (_url, init?: RequestInit) =>
    catalog([{ id: modelIds[authorization(init)] ?? "public/model" }]),
  );
  vi.stubGlobal("fetch", mockFetch);
  expect((await discoverChutesModels("a"))[0]?.id).toBe("private/a");
  expect((await discoverChutesModels("b"))[0]?.id).toBe("private/b");
  expect((await discoverChutesModels("a"))[0]?.id).toBe("private/a");
  expect(mockFetch).toHaveBeenCalledTimes(2);
});

it("does not replace rejected account discovery with an anonymous catalog", async () => {
  const mockFetch = vi.fn(async (_url, init?: RequestInit) =>
    authorization(init) === "Bearer failed"
      ? new Response("", { status: 401 })
      : catalog([{ id: "public/model" }]),
  );
  vi.stubGlobal("fetch", mockFetch);
  await expect(discoverChutesModels("failed", { discoveryMode: "strict" })).rejects.toMatchObject({
    status: 401,
  });
  await expect(buildChutesProvider("failed")).resolves.toMatchObject({
    models: [{ id: "public/model" }],
  });
  const authorizations = mockFetch.mock.calls.map(([, init]) => authorization(init));
  expect(authorizations).toEqual(["Bearer failed", "Bearer failed", ""]);
});
