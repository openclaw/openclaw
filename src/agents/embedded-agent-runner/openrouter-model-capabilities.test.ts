import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createCorePluginStateSyncKeyedStore } from "../../plugin-state/plugin-state-store.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { closePreparedModelRuntimeSnapshots } from "../prepared-model-runtime.lifecycle.js";

let stateDir: string;

async function freshCapabilities(scope: string) {
  // Import fresh per scope so module-level caches cannot mask persistence bugs.
  const module = await importFreshModule<typeof import("./openrouter-model-capabilities.js")>(
    import.meta.url,
    `./openrouter-model-capabilities.js?scope=${scope}`,
  );
  return {
    load: module.loadOpenRouterModelCapabilities,
    get: module.getOpenRouterModelCapabilities,
    loaded: module.getLoadedOpenRouterModelCapabilities,
  };
}

async function expectNoSyncSql(run: () => Promise<void>) {
  const sql = observeHostDataSql();
  try {
    await run();
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
}

function mockResponses(...responses: Response[]) {
  const fetchSpy = vi.fn();
  for (const response of responses) {
    fetchSpy.mockResolvedValueOnce(response);
  }
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function mockCatalog(data: unknown[], chunked = false) {
  const fetchSpy = vi.fn(async () => {
    if (!chunked) {
      return Response.json({ data });
    }
    const encoded = new TextEncoder().encode(JSON.stringify({ data }));
    let offset = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= encoded.length) {
            controller.close();
            return;
          }
          controller.enqueue(encoded.subarray(offset, offset + 8));
          offset += 8;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function storedModels(namespace = "models.v4") {
  return createCorePluginStateSyncKeyedStore({
    ownerId: "core:openrouter-model-capabilities",
    namespace,
    maxEntries: 10_000,
  });
}

describe("openrouter-model-capabilities", () => {
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "openclaw-openrouter-capabilities-"));
    resetPluginStateStoreForTests();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    for (const key of [
      "ALL_PROXY",
      "all_proxy",
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
    ]) {
      vi.stubEnv(key, "");
    }
  });
  afterEach(async () => {
    try {
      await closePreparedModelRuntimeSnapshots();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("uses top-level OpenRouter max token fields when top_provider is absent", async () => {
    mockCatalog([
      {
        id: "acme/top-level-max-completion",
        architecture: { modality: "text+image->text" },
        supported_parameters: ["reasoning", "tools"],
        context_length: 65432,
        max_completion_tokens: 12345,
      },
      {
        id: "acme/top-level-max-output",
        modality: "text+image->text",
        context_length: 54321,
        max_output_tokens: 23456,
      },
      {
        id: "perplexity/sonar-deep-research",
        supported_parameters: ["reasoning", "web_search_options"],
      },
    ]);

    const module = await freshCapabilities("top-level-max-tokens");
    await expectNoSyncSql(() => module.load("acme/top-level-max-completion"));

    expect(module.get("acme/top-level-max-completion")).toMatchObject({
      input: ["text", "image"],
      reasoning: true,
      supportsTools: true,
      contextWindow: 65432,
      maxTokens: 12345,
    });

    const maxOutput = module.get("acme/top-level-max-output");
    expect(maxOutput).toMatchObject({
      input: ["text", "image"],
      reasoning: false,
      contextWindow: 54321,
      maxTokens: 23456,
    });
    expect(maxOutput?.supportsTools).toBeUndefined();
    expect(module.get("perplexity/sonar-deep-research")?.supportsTools).toBe(false);
  });

  it("persists a fetched catalog to the store selected before the network wait", async () => {
    const requested = createDeferredCore();
    const response = createDeferredCore<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        requested.resolve();
        return response.promise;
      }),
    );
    const module = await freshCapabilities("captured-store");
    const loading = module.load("acme/captured-model");
    await requested.promise;
    await withEnvAsync({ OPENCLAW_STATE_DIR: join(stateDir, "successor") }, async () => {
      response.resolve(Response.json({ data: [{ id: "acme/captured-model" }] }));
      await loading;
      expect(storedModels().entries()).toEqual([]);
    });
    expect(storedModels().entries()).toEqual([
      expect.objectContaining({ key: "acme/captured-model" }),
    ]);
  });

  it("preserves chunked native pricing and reasoning capabilities in memory and across SQLite reads", async () => {
    const modelId = "acme/sqlite-cached-model";
    const baseCost = {
      input: 2,
      output: 10,
      cacheRead: expect.closeTo(0.2, 12),
      cacheWrite: 2.5,
    };
    const cost = {
      ...baseCost,
      tieredPricing: [
        { ...baseCost, range: [0, 272_001] },
        { ...baseCost, input: 4, range: [272_001] },
      ],
    };
    const expected = {
      input: ["text", "image"],
      reasoning: true,
      compat: { supportedReasoningEfforts: ["high", "low"] },
      thinkingLevelMap: { off: null },
      supportsTools: true,
      contextWindow: 8765,
      maxTokens: 4321,
      cost,
    };
    const fetchSpy = mockCatalog(
      [
        {
          id: modelId,
          architecture: { modality: "text+image->text" },
          supported_parameters: ["tools"],
          reasoning: { supported_efforts: ["high", "low"], mandatory: true },
          context_length: 8765,
          max_completion_tokens: 4321,
          pricing: {
            prompt: "0.000002",
            completion: "0.00001",
            input_cache_read: "0.0000002",
            input_cache_write: "0.0000025",
            overrides: [
              {
                min_prompt_tokens: 272_000,
                prompt: "0.000004",
              },
            ],
          },
        },
      ],
      true,
    );

    const writer = await freshCapabilities("sqlite-cache-writer");
    await writer.load(modelId);
    expect(writer.get(modelId)?.cost).toEqual(cost);
    expect(writer.loaded(modelId)).toMatchObject(expected);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const reader = await freshCapabilities("sqlite-cache-reader");
    await expectNoSyncSql(() => reader.load(modelId));
    expect(reader.loaded(modelId)).toMatchObject(expected);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each(["JSON v2", "SQLite v3"] as const)(
    "refreshes retired %s caches after an unavailable catalog without reusing stale metadata",
    async (format) => {
      const json = format === "JSON v2";
      const modelId = json ? "nvidia/nemotron-3-super-120b-a12b:free" : "minimax/minimax-m2.7";
      const legacy = {
        name: modelId,
        input: ["text"],
        reasoning: !json,
        contextWindow: json ? 1_000_000 : 32_000,
        maxTokens: json ? 262_144 : 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      if (json) {
        const cacheDir = join(stateDir, "cache");
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(
          join(cacheDir, "openrouter-models.json"),
          JSON.stringify({ version: 2, models: { [modelId]: legacy } }),
        );
      } else {
        storedModels("models.v3").register(modelId, legacy);
      }
      const refreshed = json
        ? {
            id: modelId,
            context_length: 1_000_000,
            top_provider: { context_length: 262_144, max_completion_tokens: 262_144 },
            pricing: { prompt: "0", completion: "0" },
          }
        : { id: modelId, reasoning: { mandatory: true } };
      const expected = json
        ? { contextWindow: 262_144, maxTokens: 262_144 }
        : {
            compat: { supportsReasoningEffort: false },
            thinkingLevelMap: { off: null },
          };
      const failedResponse = new Response("temporarily unavailable", { status: 503 });
      const cancel = vi.spyOn(failedResponse.body!, "cancel").mockResolvedValue(undefined);
      const fetchSpy = mockResponses(failedResponse, Response.json({ data: [refreshed] }));
      const cache = await freshCapabilities("cache-upgrade-" + format);
      await cache.load(modelId);
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
      expect(cache.get(modelId)).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledOnce();

      await cache.load(modelId);
      expect(cache.get(modelId)).toMatchObject(expected);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const reader = await freshCapabilities("cache-recovered-" + format);
      expect(reader.get(modelId)).toMatchObject(expected);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    },
  );

  it("preserves cached capabilities when a refresh has non-array data", async () => {
    const modelId = "acme/healthy-model";
    const fetchSpy = mockResponses(
      Response.json({ data: [{ id: modelId, name: "Healthy Model", context_length: 8192 }] }),
      Response.json({ data: {} }),
    );

    const writer = await freshCapabilities("malformed-writer");
    await writer.load(modelId);
    await writer.load("acme/new-model");

    expect(writer.get(modelId)?.name).toBe("Healthy Model");
    const reader = await freshCapabilities("malformed-reader");
    expect(reader.get(modelId)?.name).toBe("Healthy Model");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("bounds an oversized streamed OpenRouter catalog instead of buffering it whole", async () => {
    // Bounded reading must cancel before consuming the endless small chunks.
    let pullCount = 0;
    const cancel = vi.fn(async () => undefined);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        controller.enqueue(new Uint8Array(pullCount === 1 ? 16 * 1024 * 1024 + 1 : 1));
      },
      cancel,
    });
    const fetchSpy = mockResponses(new Response(stream));

    const module = await freshCapabilities("oversized-stream");
    await module.load("acme/anything");

    expect(pullCount).toBeLessThanOrEqual(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(module.get("acme/anything")).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each(["get", "loaded"] as const)(
    "does not refetch immediately after an awaited miss through %s",
    async (firstLookup) => {
      const fetchSpy = mockCatalog([{ id: "acme/known-model" }]);

      const module = await freshCapabilities(`awaited-miss-${firstLookup}`);
      await module.load("acme/missing-model");
      expect(module[firstLookup]("acme/missing-model")).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      expect(module.get("acme/missing-model")).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    },
  );

  it("reads only loaded capabilities and follows catalog refreshes", async () => {
    const modelId = "acme/refreshed-model";
    const catalog = (efforts: string[]) =>
      Response.json({
        data: [{ id: modelId, reasoning: { supported_efforts: efforts, mandatory: true } }],
      });
    const fetchSpy = mockResponses(catalog(["xhigh", "high"]), catalog(["high"]));
    const writer = await freshCapabilities("loaded-writer");
    await writer.load(modelId);

    // A cold process has SQLite rows available but must not read them or fetch.
    const reader = await freshCapabilities("loaded-reader");
    expect(reader.loaded(modelId)).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledOnce();

    await reader.load(modelId);
    expect(reader.loaded(modelId)?.compat?.supportedReasoningEfforts).toEqual(["xhigh", "high"]);

    await reader.load("acme/new-model");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(reader.loaded(modelId)?.compat?.supportedReasoningEfforts).toEqual(["high"]);
  });
});
