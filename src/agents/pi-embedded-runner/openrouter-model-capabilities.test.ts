import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";

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
      const stateDatabase = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const stateDb = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(stateDatabase.db);
      executeSqliteQuerySync(
        stateDatabase.db,
        stateDb.insertInto("model_capability_cache").values({
          provider_id: "openrouter",
          model_id: "acme/sqlite-cached",
          name: "SQLite Cached",
          input_text: 1,
          input_image: 1,
          reasoning: 1,
          supports_tools: null,
          context_window: 222_000,
          max_tokens: 33_000,
          cost_input: 1,
          cost_output: 2,
          cost_cache_read: 3,
          cost_cache_write: 4,
          updated_at_ms: 1,
        }),
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
                    supported_parameters: ["reasoning", "tools"],
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
      expect(maxCompletion?.supportsTools).toBe(true);
      expect(maxCompletion?.contextWindow).toBe(65432);
      expect(maxCompletion?.maxTokens).toBe(12345);

      const maxOutput = module.getOpenRouterModelCapabilities("acme/top-level-max-output");
      expect(maxOutput?.input).toEqual(["text", "image"]);
      expect(maxOutput?.reasoning).toBe(false);
      expect(maxOutput?.supportsTools).toBeUndefined();
      expect(maxOutput?.contextWindow).toBe(54321);
      expect(maxOutput?.maxTokens).toBe(23456);
    });
  });

  it("preserves explicit OpenRouter tool support metadata", async () => {
    await withOpenRouterStateDir(async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                data: [
                  {
                    id: "perplexity/sonar-deep-research",
                    name: "Sonar Deep Research",
                    supported_parameters: ["reasoning", "web_search_options"],
                  },
                  {
                    id: "google/gemini-2.5-pro",
                    name: "Gemini 2.5 Pro",
                    supported_parameters: ["reasoning", "tools"],
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

      const module = await importOpenRouterModelCapabilities("tool-support");
      await module.loadOpenRouterModelCapabilities("perplexity/sonar-deep-research");

      expect(
        module.getOpenRouterModelCapabilities("perplexity/sonar-deep-research")?.supportsTools,
      ).toBe(false);
      expect(module.getOpenRouterModelCapabilities("google/gemini-2.5-pro")?.supportsTools).toBe(
        true,
      );
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
