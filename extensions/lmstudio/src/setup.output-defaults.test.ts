import {
  createNonExitingRuntimeEnv,
  createQueuedWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { afterEach, expect, it, vi } from "vitest";
import {
  configureLmstudioNonInteractive,
  prepareAppGuidedLmstudioSetup,
  promptAndConfigureLmstudioInteractive,
} from "./setup.js";

const baseUrl = "http://fixture.invalid/v1";
const modelId = "fixture/local-model";
afterEach(() => vi.unstubAllGlobals());

it.each([
  [undefined, undefined, "65536", 32_768],
  [8_192, undefined, "65536", 8_192],
  [49_152, undefined, "65536", 49_152],
  [8_192, undefined, "4096", 4_096],
  [8_192, 24_576, "65536", 24_576],
] as const)(
  "setup preserves output defaults (provider %s, model %s, context %s)",
  async (providerCap, modelCap, preferred, interactiveCap) => {
    // Only external HTTP is fixed: discovery, setup, and the shared CLI helper are real.
    const fetchMock = vi.fn(async () =>
      Response.json({
        models: [
          {
            type: "llm",
            key: modelId,
            max_context_length: 131_072,
            capabilities: { trained_for_tool_use: true },
            loaded_instances: [{ id: "loaded64", config: { context_length: 65_536 } }],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const models: ModelDefinitionConfig[] =
      modelCap === undefined
        ? []
        : [
            {
              id: modelId,
              name: modelId,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: modelCap,
            },
          ];
    const config: OpenClawConfig = {
      models: {
        providers: {
          lmstudio: {
            baseUrl,
            api: "openai-completions",
            maxTokens: providerCap,
            models,
          },
        },
      },
    };
    const { prompter } = createQueuedWizardPrompter({
      textValues: [baseUrl, "fixture-key", preferred],
    });
    const interactive = await promptAndConfigureLmstudioInteractive({ config, prompter });
    const guided = await prepareAppGuidedLmstudioSetup({ config, env: {} });
    const nonInteractive = await configureLmstudioNonInteractive({
      authChoice: "lmstudio",
      config,
      baseConfig: config,
      opts: { customBaseUrl: baseUrl, customModelId: modelId },
      runtime: createNonExitingRuntimeEnv(),
      // An existing profile avoids credential writes without replacing the setup owner.
      resolveApiKey: async () => ({ key: "fixture-key", source: "profile" }),
      toApiKeyCredential: () => null,
    });
    for (const [result, maxTokens, contextTokens] of [
      [interactive.configPatch, interactiveCap, Number(preferred)],
      [guided?.configPatch, modelCap ?? providerCap ?? 32_768, 65_536],
      [nonInteractive, modelCap ?? providerCap ?? 32_768, 65_536],
    ] as const) {
      expect(result?.models?.providers?.lmstudio).toMatchObject({
        maxTokens: providerCap,
        models: [{ id: modelId, contextWindow: 131_072, contextTokens, maxTokens }],
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://fixture.invalid/api/v1/models",
      expect.anything(),
    );
  },
);
