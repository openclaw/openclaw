import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { Model } from "openclaw/plugin-sdk/llm";
import {
  createRuntimeEnv,
  registerProviderPlugin,
  requireRegisteredProvider,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { describe, expect, it, vi } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import { buildTokenHubProvider, buildTokenPlanProvider } from "./api.js";
import tencentPlugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

type OpenAICompletionsModel = Model<"openai-completions">;

const registerTencentPlugin = () =>
  registerProviderPlugin({ plugin: tencentPlugin, id: "tencent", name: "Tencent Cloud Provider" });

async function getProvider(id = "tencent-tokenhub") {
  const { providers } = await registerTencentPlugin();
  return requireRegisteredProvider(providers, id);
}

function hyReasoningModel(
  id: "hy3" | "hy3-preview" | "hy4-preview" = "hy3",
  provider: "tencent-tokenhub" | "tencent-tokenplan" = "tencent-tokenhub",
): OpenAICompletionsModel {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl:
      provider === "tencent-tokenhub"
        ? "https://tokenhub.tencentmaas.com/v1"
        : "https://api.lkeap.cloud.tencent.com/plan/v3",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 64_000,
    compat: {
      supportsUsageInStreaming: true,
      supportsReasoningEffort: true,
      supportedReasoningEfforts: id === "hy3-preview" ? ["none", "low", "high"] : ["none", "high"],
    },
  } as OpenAICompletionsModel;
}

function capturePayload(
  provider: Awaited<ReturnType<typeof getProvider>>,
  model: OpenAICompletionsModel,
  reasoning: string,
) {
  let captured: Record<string, unknown> | undefined;
  const baseStreamFn: StreamFn = (_model, context, options) => {
    const payload = buildOpenAICompletionsParams(
      _model as OpenAICompletionsModel,
      context,
      options as Parameters<typeof buildOpenAICompletionsParams>[2],
    );
    options?.onPayload?.(payload, _model);
    captured = payload;
    return {} as ReturnType<StreamFn>;
  };
  const wrapped = provider.wrapStreamFn?.({
    streamFn: baseStreamFn,
    provider: model.provider,
    modelId: model.id,
    model,
    thinkingLevel: "high",
  });
  if (!wrapped) {
    throw new Error("expected Tencent provider stream wrapper");
  }
  void wrapped(model, { messages: [] } as never, { reasoning } as never);
  return captured;
}

describe("tencent provider plugin", () => {
  it.each([
    { providerId: "tencent-tokenhub", choiceId: "tokenhub-api-key", build: buildTokenHubProvider },
    {
      providerId: "tencent-tokenplan",
      choiceId: "tokenplan-api-key",
      build: buildTokenPlanProvider,
    },
  ])(
    "keeps $providerId generated rows out of merge config",
    async ({ providerId, choiceId, build }) => {
      const { providers } = await registerTencentPlugin();
      const runNonInteractive = resolveProviderPluginChoice({ providers, choice: choiceId })?.method
        .runNonInteractive;
      if (!runNonInteractive) {
        throw new Error("expected Tencent noninteractive auth method");
      }
      const toApiKeyCredential = vi.fn(() => null);
      const apply = (config: OpenClawConfig) =>
        runNonInteractive({
          authChoice: choiceId,
          config,
          baseConfig: config,
          opts: {},
          runtime: createRuntimeEnv(),
          resolveApiKey: async () => ({ key: "stored-test-key", source: "profile" }),
          toApiKeyCredential,
        });
      expect((await apply({}))?.models?.providers?.[providerId]?.models).toEqual([]);
      const provider = build();
      // Authored config rows cannot carry the catalog-only family.
      const authored = provider.models.map(({ family: _family, ...model }) =>
        Object.assign({}, model, { id: `operator-${model.id}` }),
      );
      const result = await apply({
        models: { mode: "merge", providers: { [providerId]: { ...provider, models: authored } } },
      });
      expect(result?.models?.providers?.[providerId]?.models).toEqual(authored);
      expect(toApiKeyCredential).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["tokenhub", "TokenHub", ["hy4-preview", "hy3", "hy3-preview"]],
    ["tokenplan", "TokenPlan", ["hy4-preview", "hy3"]],
  ] as const)(
    "configures only %s through its registered auth choice in replace mode",
    async (endpoint, label, modelIds) => {
      const providerId = `tencent-${endpoint}` as const;
      const choiceId = `${endpoint}-api-key`;
      const aliases = Object.fromEntries(
        modelIds.map((id) => [
          `${providerId}/${id}`,
          { alias: `${id.replace("hy", "Hy").replace("-", " ")} (${label})` },
        ]),
      );
      const { providers } = await registerTencentPlugin();
      const resolved = resolveProviderPluginChoice({ providers, choice: choiceId });
      expect(resolved?.provider.id).toBe(providerId);
      const resolveApiKey = vi.fn(async () => ({
        key: "stored-test-key",
        source: "profile" as const,
      }));
      const toApiKeyCredential = vi.fn(() => null);
      const method = resolved?.method;
      if (!method?.runNonInteractive) {
        throw new Error("expected Tencent noninteractive auth method");
      }
      const config = await method.runNonInteractive({
        authChoice: choiceId,
        config: { models: { mode: "replace" } },
        baseConfig: { models: { mode: "replace" } },
        opts: { tokenhubApiKey: "tokenhub-test-key", tokenplanApiKey: "tokenplan-test-key" },
        runtime: createRuntimeEnv(),
        resolveApiKey,
        toApiKeyCredential,
      });

      expect(resolveApiKey).toHaveBeenCalledExactlyOnceWith({
        provider: providerId,
        flagValue: `${endpoint}-test-key`,
        flagName: `--${choiceId}`,
        envVar: `${endpoint.toUpperCase()}_API_KEY`,
      });
      expect(toApiKeyCredential).not.toHaveBeenCalled();
      expect(Object.keys(config?.models?.providers ?? {})).toEqual([providerId]);
      expect(config?.models?.providers?.[providerId]?.models.map((model) => model.id)).toEqual(
        manifest.modelCatalog.providers[providerId].models.map((model) => model.id),
      );
      expect(config?.agents?.defaults?.model).toEqual({ primary: `${providerId}/hy4-preview` });
      expect(config?.agents?.defaults?.models).toEqual(aliases);
    },
  );

  it.each(["tencent-tokenhub", "tencent-tokenplan"])(
    "projects %s static ids and isolates augmented model inputs",
    async (providerId) => {
      const provider = await getProvider(providerId);
      const first = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
      expect(first.models.every((model) => model.api === "openai-completions")).toBe(true);

      const context = { env: {}, entries: [] };
      const augmented = await provider.augmentModelCatalog?.(context);
      expect(augmented?.map((entry) => entry.id)).toEqual(first.models.map((entry) => entry.id));
      if (!augmented?.[0]?.input) {
        throw new Error("expected Tencent model input modalities");
      }
      const expectedAugmented = structuredClone(augmented);
      augmented[0].input.push("image");
      expect(await provider.augmentModelCatalog?.(context)).toEqual(expectedAugmented);
    },
  );

  it("keeps TokenHub hy3 explicit high and none reasoning_effort unchanged", async () => {
    const provider = await getProvider();
    const model = hyReasoningModel();

    model.compat = { ...model.compat, supportsStore: false };
    expect(JSON.stringify(capturePayload(provider, model, "high"))).toBe(
      '{"model":"hy3","messages":[],"stream":true,"stream_options":{"include_usage":true},"max_completion_tokens":64000,"reasoning_effort":"high"}',
    );
    expect(JSON.stringify(capturePayload(provider, model, "none"))).toBe(
      '{"model":"hy3","messages":[],"stream":true,"stream_options":{"include_usage":true},"max_completion_tokens":64000,"reasoning_effort":"none"}',
    );
  });

  it("does not treat inherited constructor as a Tencent effort override", async () => {
    const payload = capturePayload(await getProvider(), hyReasoningModel(), "constructor");
    expect(payload?.reasoning_effort).toBe("none");
  });

  it("collapses hy4-preview onto its two-rung ladder on both endpoints", async () => {
    const tokenHubProvider = await getProvider();
    const tokenPlanProvider = await getProvider("tencent-tokenplan");

    // Preserve the two-rung policy even when the raw API accepts low.
    const expected: Record<string, string> = {
      off: "none",
      none: "none",
      minimal: "high",
      low: "high",
      medium: "high",
      high: "high",
      xhigh: "high",
    };
    for (const [provider, model] of [
      [tokenHubProvider, hyReasoningModel("hy4-preview")],
      [tokenPlanProvider, hyReasoningModel("hy4-preview", "tencent-tokenplan")],
    ] as const) {
      for (const [reasoning, rung] of Object.entries(expected)) {
        expect(
          capturePayload(provider, model, reasoning)?.reasoning_effort,
          `${model.provider}/hy4-preview ${reasoning}`,
        ).toBe(rung);
      }
    }

    expect(
      capturePayload(tokenHubProvider, hyReasoningModel("hy3-preview"), "low")?.reasoning_effort,
    ).toBe("low");
  });
});
