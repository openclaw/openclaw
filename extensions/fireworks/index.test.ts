// Fireworks tests cover index plugin behavior.
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import {
  createProviderDynamicModelContext,
  runSingleProviderCatalog,
} from "../test-support/provider-model-test-helpers.js";
import fireworksPlugin from "./index.js";
import {
  FIREWORKS_BASE_URL,
  FIREWORKS_DEEPSEEK_V4_MODEL_ID,
  FIREWORKS_DEFAULT_CONTEXT_WINDOW,
  FIREWORKS_DEFAULT_MAX_TOKENS,
  FIREWORKS_DEFAULT_MODEL_ID,
  FIREWORKS_GLM_5_1_MODEL_ID,
  FIREWORKS_GPT_OSS_120B_MODEL_ID,
  FIREWORKS_K2_6_CONTEXT_WINDOW,
  FIREWORKS_K2_6_MAX_TOKENS,
  FIREWORKS_K2_6_MODEL_ID,
  FIREWORKS_MINIMAX_M3_MODEL_ID,
} from "./provider-catalog.js";
import { resolveThinkingProfile } from "./provider-policy-api.js";

function createFireworksDefaultRuntimeModel(params: { reasoning: boolean }): ProviderRuntimeModel {
  return {
    id: FIREWORKS_DEFAULT_MODEL_ID,
    name: FIREWORKS_DEFAULT_MODEL_ID,
    provider: "fireworks",
    api: "openai-completions",
    baseUrl: FIREWORKS_BASE_URL,
    reasoning: params.reasoning,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
    maxTokens: FIREWORKS_DEFAULT_MAX_TOKENS,
  };
}

describe("fireworks provider plugin", () => {
  it("registers Fireworks with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "fireworks-api-key",
    });

    expect(provider.id).toBe("fireworks");
    expect(provider.label).toBe("Fireworks");
    expect(provider.aliases).toEqual(["fireworks-ai"]);
    expect(provider.envVars).toEqual(["FIREWORKS_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    if (!resolved) {
      throw new Error("expected Fireworks api-key auth choice");
    }
    expect(resolved.provider.id).toBe("fireworks");
    expect(resolved.method.id).toBe("api-key");
  });

  it("builds the Fireworks catalog", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const catalogProvider = await runSingleProviderCatalog(provider);

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe(FIREWORKS_BASE_URL);
    const models = catalogProvider.models;
    if (!models) {
      throw new Error("expected Fireworks catalog models");
    }
    expect(models.map((model) => model.id)).toEqual([
      FIREWORKS_K2_6_MODEL_ID,
      FIREWORKS_DEFAULT_MODEL_ID,
      FIREWORKS_DEEPSEEK_V4_MODEL_ID,
      FIREWORKS_MINIMAX_M3_MODEL_ID,
      FIREWORKS_GLM_5_1_MODEL_ID,
      FIREWORKS_GPT_OSS_120B_MODEL_ID,
    ]);
    expect(models[0]?.reasoning).toBe(false);
    expect(models[0]?.input).toEqual(["text", "image"]);
    expect(models[0]?.contextWindow).toBe(FIREWORKS_K2_6_CONTEXT_WINDOW);
    expect(models[0]?.maxTokens).toBe(FIREWORKS_K2_6_MAX_TOKENS);
    expect(models[1]?.reasoning).toBe(false);
    expect(models[1]?.input).toEqual(["text", "image"]);
    expect(models[1]?.contextWindow).toBe(FIREWORKS_DEFAULT_CONTEXT_WINDOW);
    expect(models[1]?.maxTokens).toBe(FIREWORKS_DEFAULT_MAX_TOKENS);
  });

  it("catalogs reasoning families with reasoning_effort compat from the manifest", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const catalogProvider = await runSingleProviderCatalog(provider);
    const byId = new Map(catalogProvider.models?.map((model) => [model.id, model]) ?? []);

    const deepseek = byId.get(FIREWORKS_DEEPSEEK_V4_MODEL_ID);
    expect(deepseek?.reasoning).toBe(true);
    // thinkingFormat "openai" opts out of core's deepseek-native fallback for
    // deepseek-v4-* ids; Fireworks 400s on payloads carrying `thinking` next to
    // `reasoning_effort`.
    expect(deepseek?.compat).toMatchObject({
      thinkingFormat: "openai",
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      reasoningEffortMap: { off: "none", max: "max" },
    });

    const minimax = byId.get(FIREWORKS_MINIMAX_M3_MODEL_ID);
    expect(minimax?.reasoning).toBe(true);
    expect(minimax?.input).toEqual(["text", "image"]);
    expect(minimax?.compat).toMatchObject({
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "low", "medium", "high"],
      reasoningEffortMap: { off: "none", max: "high" },
    });

    const glm = byId.get(FIREWORKS_GLM_5_1_MODEL_ID);
    expect(glm?.reasoning).toBe(true);
    expect(glm?.compat).toMatchObject({
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "low", "medium", "high"],
      reasoningEffortMap: { off: "none", max: "high" },
    });

    const gptOss = byId.get(FIREWORKS_GPT_OSS_120B_MODEL_ID);
    expect(gptOss?.reasoning).toBe(true);
    expect(gptOss?.compat).toMatchObject({
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["low", "medium", "high"],
      reasoningEffortMap: { max: "high" },
    });
    expect(gptOss?.compat?.supportedReasoningEfforts).not.toContain("minimal");
    expect(gptOss?.compat?.reasoningEffortMap).not.toHaveProperty("off");
  });

  it("resolves forward-compat Fireworks model ids from the default template", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/qwen3.6-plus",
        models: [createFireworksDefaultRuntimeModel({ reasoning: true })],
      }),
    );

    expect(resolved?.provider).toBe("fireworks");
    expect(resolved?.id).toBe("accounts/fireworks/models/qwen3.6-plus");
    expect(resolved?.api).toBe("openai-completions");
    expect(resolved?.baseUrl).toBe(FIREWORKS_BASE_URL);
    expect(resolved?.reasoning).toBe(true);
    expect(resolved?.input).toEqual(["text", "image"]);
  });

  it("disables reasoning metadata for Fireworks Kimi dynamic models", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/kimi-k2p5",
        models: [createFireworksDefaultRuntimeModel({ reasoning: false })],
      }),
    );

    expect(resolved?.provider).toBe("fireworks");
    expect(resolved?.id).toBe("accounts/fireworks/models/kimi-k2p5");
    expect(resolved?.reasoning).toBe(false);
    expect(resolved?.input).toEqual(["text", "image"]);
  });

  it("keeps Fireworks GLM dynamic models text-only", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/glm-4p6",
        models: [createFireworksDefaultRuntimeModel({ reasoning: false })],
      }),
    );

    expect(resolved?.provider).toBe("fireworks");
    expect(resolved?.id).toBe("accounts/fireworks/models/glm-4p6");
    expect(resolved?.input).toEqual(["text"]);
  });

  it("disables reasoning metadata for Fireworks Kimi k2.5 aliases", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/routers/kimi-k2.5-turbo",
        models: [createFireworksDefaultRuntimeModel({ reasoning: false })],
      }),
    );

    expect(resolved?.provider).toBe("fireworks");
    expect(resolved?.id).toBe("accounts/fireworks/routers/kimi-k2.5-turbo");
    expect(resolved?.reasoning).toBe(false);
  });

  it("defers manifest catalog models to core static-catalog resolution", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    for (const modelId of [FIREWORKS_K2_6_MODEL_ID, FIREWORKS_DEFAULT_MODEL_ID]) {
      const resolved = provider.resolveDynamicModel?.(
        createProviderDynamicModelContext({
          provider: "fireworks",
          modelId,
          models: [createFireworksDefaultRuntimeModel({ reasoning: false })],
        }),
      );

      expect(resolved).toBeUndefined();
    }
  });

  it("derives thinking menus from each cataloged model's supportedReasoningEfforts", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: FIREWORKS_DEEPSEEK_V4_MODEL_ID,
      }),
    ).toEqual({
      levels: [
        { id: "off" },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
        { id: "xhigh" },
        { id: "max" },
      ],
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: FIREWORKS_MINIMAX_M3_MODEL_ID,
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }],
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: FIREWORKS_GLM_5_1_MODEL_ID,
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }],
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: FIREWORKS_GPT_OSS_120B_MODEL_ID,
      }),
    ).toEqual({
      levels: [{ id: "low" }, { id: "medium" }, { id: "high" }],
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/deepseek-v4-flash",
      }),
    ).toBeUndefined();
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/glm-5p2",
      }),
    ).toBeUndefined();
  });

  it("exposes off-only thinking policy for Fireworks Kimi models", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);

    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: "accounts/fireworks/routers/kimi-k2p5-turbo",
      }),
    ).toEqual({
      levels: [{ id: "off" }],
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: FIREWORKS_K2_6_MODEL_ID,
      }),
    ).toEqual({
      levels: [{ id: "off" }],
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/qwen3.6-plus",
      }),
    ).toBeUndefined();
    expect(resolveThinkingProfile({ modelId: FIREWORKS_K2_6_MODEL_ID })).toEqual({
      levels: [{ id: "off" }],
    });
    expect(
      resolveThinkingProfile({
        modelId: "accounts/fireworks/models/qwen3.6-plus",
      }),
    ).toBeUndefined();
  });
});
