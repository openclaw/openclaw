import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { writeOpenClawStateKvJson } from "../../state/openclaw-state-kv.js";
import { importLegacyOpenRouterModelCapabilitiesCacheToSqlite } from "./openrouter-model-capabilities-legacy.js";

async function withOpenRouterStateDir(run: (stateDir: string) => Promise<void>) {
  const stateDir = mkdtempSync(join(tmpdir(), "openclaw-openrouter-capabilities-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
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
  try {
    await run(stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

async function importOpenRouterModelCapabilities(scope: string) {
  return await importFreshModule<typeof import("./openrouter-model-capabilities.js")>(
    import.meta.url,
    `./openrouter-model-capabilities.js?scope=${scope}`,
  );
}

describe("openrouter-model-capabilities", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllGlobals();
    delete process.env.OPENCLAW_STATE_DIR;
  });

  it("loads persisted model capabilities from SQLite without the JSON cache file", async () => {
    await withOpenRouterStateDir(async (stateDir) => {
      writeOpenClawStateKvJson(
        "openrouter_model_capabilities",
        "models",
        {
          models: {
            "acme/sqlite-cached": {
              name: "SQLite Cached",
              input: ["text", "image"],
              reasoning: true,
              contextWindow: 222_000,
              maxTokens: 33_000,
              cost: {
                input: 1,
                output: 2,
                cacheRead: 3,
                cacheWrite: 4,
              },
            },
          },
        },
        { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
      );
      const fetchSpy = vi.fn(async () => {
        throw new Error("unexpected OpenRouter fetch");
      });
      vi.stubGlobal("fetch", fetchSpy);

      const module = await importOpenRouterModelCapabilities("sqlite-cache");
      await module.loadOpenRouterModelCapabilities("acme/sqlite-cached");

      expect(module.getOpenRouterModelCapabilities("acme/sqlite-cached")).toMatchObject({
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 222_000,
        maxTokens: 33_000,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  it("imports legacy JSON cache into SQLite through the doctor migration helper", async () => {
    await withOpenRouterStateDir(async (stateDir) => {
      const cachePath = join(stateDir, "cache", "openrouter-models.json");
      mkdirSync(join(stateDir, "cache"), { recursive: true });
      writeFileSync(
        cachePath,
        JSON.stringify({
          models: {
            "acme/legacy-json": {
              name: "Legacy JSON",
              input: ["text"],
              reasoning: false,
              contextWindow: 111_000,
              maxTokens: 22_000,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
            },
          },
        }),
      );
      const fetchSpy = vi.fn(async () => {
        throw new Error("unexpected OpenRouter fetch");
      });
      vi.stubGlobal("fetch", fetchSpy);

      const module = await importOpenRouterModelCapabilities("legacy-json-cache");
      await module.loadOpenRouterModelCapabilities("acme/legacy-json");
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      expect(importLegacyOpenRouterModelCapabilitiesCacheToSqlite()).toEqual({
        imported: true,
        models: 1,
      });
      const migratedModule = await importOpenRouterModelCapabilities("legacy-json-cache-migrated");
      await migratedModule.loadOpenRouterModelCapabilities("acme/legacy-json");

      expect(migratedModule.getOpenRouterModelCapabilities("acme/legacy-json")).toMatchObject({
        name: "Legacy JSON",
        contextWindow: 111_000,
        maxTokens: 22_000,
      });
      expect(existsSync(cachePath)).toBe(false);
    });
  });

  it("uses top-level OpenRouter max token fields when top_provider is absent", async () => {
    await withOpenRouterStateDir(async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                data: [
                  {
                    id: "acme/top-level-max-completion",
                    name: "Top Level Max Completion",
                    architecture: { modality: "text+image->text" },
                    supported_parameters: ["reasoning"],
                    context_length: 65432,
                    max_completion_tokens: 12345,
                    pricing: { prompt: "0.000001", completion: "0.000002" },
                  },
                  {
                    id: "acme/top-level-max-output",
                    name: "Top Level Max Output",
                    modality: "text+image->text",
                    context_length: 54321,
                    max_output_tokens: 23456,
                    pricing: { prompt: "0.000003", completion: "0.000004" },
                  },
                ],
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            ),
        ),
      );

      const module = await importOpenRouterModelCapabilities("top-level-max-tokens");
      await module.loadOpenRouterModelCapabilities("acme/top-level-max-completion");

      const maxCompletion = module.getOpenRouterModelCapabilities("acme/top-level-max-completion");
      expect(maxCompletion?.input).toEqual(["text", "image"]);
      expect(maxCompletion?.reasoning).toBe(true);
      expect(maxCompletion?.contextWindow).toBe(65432);
      expect(maxCompletion?.maxTokens).toBe(12345);

      const maxOutput = module.getOpenRouterModelCapabilities("acme/top-level-max-output");
      expect(maxOutput?.input).toEqual(["text", "image"]);
      expect(maxOutput?.reasoning).toBe(false);
      expect(maxOutput?.contextWindow).toBe(54321);
      expect(maxOutput?.maxTokens).toBe(23456);
    });
  });

  it("does not refetch immediately after an awaited miss for the same model id", async () => {
    await withOpenRouterStateDir(async () => {
      const fetchSpy = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "acme/known-model",
                  name: "Known Model",
                  architecture: { modality: "text->text" },
                  context_length: 1234,
                },
              ],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      vi.stubGlobal("fetch", fetchSpy);

      const module = await importOpenRouterModelCapabilities("awaited-miss");
      await module.loadOpenRouterModelCapabilities("acme/missing-model");
      expect(module.getOpenRouterModelCapabilities("acme/missing-model")).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      expect(module.getOpenRouterModelCapabilities("acme/missing-model")).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });
});
