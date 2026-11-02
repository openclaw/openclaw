import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import openrouterPlugin from "./index.js";

const BASE_URL = "https://openrouter.ai/api/v1";

describe("OpenRouter static catalog preparation", () => {
  let stateDir: string | undefined;

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    resetPluginStateStoreForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    if (stateDir) {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("loads catalog capabilities only for a static run that selects OpenRouter", async () => {
    stateDir = mkdtempSync(join(tmpdir(), "openclaw-openrouter-static-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    for (const name of ["ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY"]) {
      vi.stubEnv(name, "");
      vi.stubEnv(name.toLowerCase(), "");
    }
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [
          { id: "openrouter/auto", name: "Auto Router", context_length: 2_000_000 },
          {
            id: "openai/gpt-5",
            name: "OpenAI: GPT-5",
            supported_parameters: ["reasoning", "reasoning_effort", "tools"],
            reasoning: {
              mandatory: true,
              supported_efforts: ["high", "medium", "low", "minimal"],
              default_effort: "medium",
            },
            context_length: 400_000,
            top_provider: { max_completion_tokens: 128_000 },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const runStatic = (providerIds?: string[]) =>
      provider.staticCatalog?.run({
        config: {},
        env: process.env,
        ...(providerIds ? { providerIds } : {}),
        resolveProviderApiKey: () => ({ apiKey: undefined }),
        resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
      });

    // Unscoped validation (doctor) must not contact OpenRouter.
    await runStatic();
    await runStatic(["anthropic"]);
    expect(fetchMock).not.toHaveBeenCalled();

    await runStatic(["openrouter"]);
    expect(fetchMock).toHaveBeenCalledOnce();

    // Static completion and thinking profiles are synchronous memory reads.
    const model = provider.resolveDynamicModel?.({
      config: {},
      provider: "openrouter",
      modelId: "openai/gpt-5",
      modelRegistry: { find: () => null } as never,
    });
    expect(model).toMatchObject({ reasoning: true, contextWindow: 400_000, maxTokens: 128_000 });
    const profile = provider.resolveThinkingProfile?.({
      provider: "openrouter",
      modelId: "openai/gpt-5",
      api: "openai-completions",
      baseUrl: BASE_URL,
      reasoning: model?.reasoning,
    });
    expect(profile?.levels.map((level) => level.id)).toEqual(["minimal", "low", "medium", "high"]);
  });
});
