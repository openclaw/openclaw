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
  FIREWORKS_DEFAULT_CONTEXT_WINDOW,
  FIREWORKS_DEFAULT_MAX_TOKENS,
  FIREWORKS_DEFAULT_MODEL_ID,
  FIREWORKS_K2_6_CONTEXT_WINDOW,
  FIREWORKS_K2_6_MAX_TOKENS,
  FIREWORKS_K2_6_MODEL_ID,
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
      "accounts/fireworks/models/deepseek-v4-pro",
      "accounts/fireworks/models/minimax-m2p7",
      "accounts/fireworks/models/glm-5p1",
      "accounts/fireworks/models/gpt-oss-120b",
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

    const deepseek = byId.get("accounts/fireworks/models/deepseek-v4-pro");
    expect(deepseek?.reasoning).toBe(true);
    // thinkingFormat "openai" opts out of core's deepseek-native fallback for
    // deepseek-v4-* ids; Fireworks 400s on payloads carrying `thinking` next to
    // `reasoning_effort`.
    expect(deepseek?.compat).toMatchObject({
      thinkingFormat: "openai",
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      reasoningEffortMap: { off: "none", minimal: "low", max: "max" },
    });

    const minimax = byId.get("accounts/fireworks/models/minimax-m2p7");
    expect(minimax?.reasoning).toBe(true);
    expect(minimax?.compat).toMatchObject({
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["low", "medium", "high"],
      reasoningEffortMap: { minimal: "low", max: "high" },
    });
    expect(minimax?.compat?.reasoningEffortMap).not.toHaveProperty("off");

    const glm = byId.get("accounts/fireworks/models/glm-5p1");
    expect(glm?.reasoning).toBe(true);
    expect(glm?.compat).toMatchObject({
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "low", "medium", "high"],
      reasoningEffortMap: { off: "none", max: "high" },
    });

    const gptOss = byId.get("accounts/fireworks/models/gpt-oss-120b");
    expect(gptOss?.reasoning).toBe(true);
    expect(gptOss?.compat).toMatchObject({
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["low", "medium", "high"],
      reasoningEffortMap: { minimal: "low", max: "high" },
    });
    expect(gptOss?.compat?.supportedReasoningEfforts).not.toContain("minimal");
    // No-off rows share one convention: omit `off` from the map so a bypassed
    // off request sends no reasoning_effort instead of a silent low.
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
    // glm-5p1 is a manifest row (deferred to core); use a non-cataloged GLM id
    // to exercise the dynamic text-only path.
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

  it("carries the GLM effort compat on dynamic GLM-5+ ids", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    // Profile-matched dynamic ids need explicit effort compat: the proxy-like
    // Fireworks endpoint disables detected reasoning_effort, so without it the
    // advertised off/on menu would never encode on the request.
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/glm-5p2",
        models: [createFireworksDefaultRuntimeModel({ reasoning: false })],
      }),
    );

    expect(resolved?.id).toBe("accounts/fireworks/models/glm-5p2");
    expect(resolved?.compat).toMatchObject({
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "low", "medium", "high"],
    });
  });

  it("opts dynamic DeepSeek V4 ids out of the deepseek-native thinking format", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    // Non-cataloged deepseek-v4 id: core's fallback matches the id family, so
    // dynamic resolution must carry the same thinkingFormat opt-out as the
    // deepseek-v4-pro manifest row.
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/deepseek-v4-flash",
        models: [
          {
            ...createFireworksDefaultRuntimeModel({ reasoning: false }),
            compat: { unsupportedToolSchemaKeywords: ["not"] },
          },
        ],
      }),
    );

    expect(resolved?.id).toBe("accounts/fireworks/models/deepseek-v4-flash");
    expect(resolved?.reasoning).toBe(true);
    // Inherits the cataloged v4-pro compat (effort surface included, so the
    // advertised off..max profile encodes faithfully) merged into the cloned
    // template compat, not replacing it.
    expect(resolved?.compat).toMatchObject({
      thinkingFormat: "openai",
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      unsupportedToolSchemaKeywords: ["not"],
    });
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

  it("disables reasoning metadata for Fireworks Kimi k2.6 dynamic models", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/kimi-k2p6",
        models: [createFireworksDefaultRuntimeModel({ reasoning: false })],
      }),
    );

    expect(resolved?.provider).toBe("fireworks");
    expect(resolved?.id).toBe("accounts/fireworks/models/kimi-k2p6");
    expect(resolved?.reasoning).toBe(false);
  });

  it("exposes per-family thinking profiles for Fireworks reasoning models", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);

    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/deepseek-v4-pro",
      }),
    ).toEqual({
      levels: [
        { id: "off" },
        { id: "low", rank: 20 },
        { id: "medium", rank: 30 },
        { id: "high", rank: 40 },
        { id: "xhigh", rank: 60 },
        { id: "max", rank: 80 },
      ],
      defaultLevel: "high",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/minimax-m2p7",
      }),
    ).toEqual({
      levels: [
        { id: "low", rank: 20 },
        { id: "medium", rank: 30 },
        { id: "high", rank: 40 },
      ],
      defaultLevel: "medium",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/glm-5p1",
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low", label: "on", rank: 20 }],
      defaultLevel: "low",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/gpt-oss-120b",
      }),
    ).toEqual({
      levels: [
        { id: "low", rank: 20 },
        { id: "medium", rank: 30 },
        { id: "high", rank: 40 },
      ],
      defaultLevel: "low",
    });
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
      defaultLevel: "off",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: FIREWORKS_K2_6_MODEL_ID,
      }),
    ).toEqual({
      levels: [{ id: "off" }],
      defaultLevel: "off",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/qwen3.6-plus",
      }),
    ).toBeUndefined();
    expect(resolveThinkingProfile({ modelId: FIREWORKS_K2_6_MODEL_ID })).toEqual({
      levels: [{ id: "off" }],
      defaultLevel: "off",
    });
    expect(
      resolveThinkingProfile({
        modelId: "accounts/fireworks/models/qwen3.6-plus",
      }),
    ).toBeUndefined();
  });
});
