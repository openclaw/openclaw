import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
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
import tencentPlugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

type OpenAICompletionsModel = Model<"openai-completions">;

const registerTencentPlugin = () =>
  registerProviderPlugin({
    plugin: tencentPlugin,
    id: "tencent",
    name: "Tencent Cloud Provider",
  });

async function getTokenHubProvider() {
  const { providers } = await registerTencentPlugin();
  return requireRegisteredProvider(providers, "tencent-tokenhub");
}

async function getTokenPlanProvider() {
  const { providers } = await registerTencentPlugin();
  return requireRegisteredProvider(providers, "tencent-tokenplan");
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

function captureTencentPayload(params: {
  provider: Pick<Awaited<ReturnType<typeof getTokenHubProvider>>, "wrapStreamFn">;
  model: OpenAICompletionsModel;
  reasoning: string;
}) {
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
  const wrapped = params.provider.wrapStreamFn?.({
    streamFn: baseStreamFn,
    provider: params.model.provider,
    modelId: params.model.id,
    model: params.model,
    thinkingLevel: "high",
  });
  if (!wrapped) {
    throw new Error("expected Tencent provider stream wrapper");
  }
  void wrapped(
    params.model,
    { messages: [] } as never,
    {
      reasoning: params.reasoning,
    } as never,
  );
  return captured;
}

describe("tencent provider plugin", () => {
  it.each([
    {
      providerId: "tencent-tokenhub",
      choiceId: "tokenhub-api-key",
      flagValue: "tokenhub-test-key",
      envVar: "TOKENHUB_API_KEY",
      aliases: {
        "tencent-tokenhub/hy4-preview": { alias: "Hy4 preview (TokenHub)" },
        "tencent-tokenhub/hy3": { alias: "Hy3 (TokenHub)" },
        "tencent-tokenhub/hy3-preview": { alias: "Hy3 preview (TokenHub)" },
      },
    },
    {
      providerId: "tencent-tokenplan",
      choiceId: "tokenplan-api-key",
      flagValue: "tokenplan-test-key",
      envVar: "TOKENPLAN_API_KEY",
      aliases: {
        "tencent-tokenplan/hy4-preview": { alias: "Hy4 preview (TokenPlan)" },
        "tencent-tokenplan/hy3": { alias: "Hy3 (TokenPlan)" },
      },
    },
  ] as const)(
    "configures only $providerId through its registered auth choice in replace mode",
    async ({ providerId, choiceId, flagValue, envVar, aliases }) => {
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
        flagValue,
        flagName: `--${choiceId}`,
        envVar,
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
      const { providers } = await registerTencentPlugin();
      const provider = requireRegisteredProvider(providers, providerId);
      const first = await runSingleProviderCatalog({ catalog: provider.staticCatalog });

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
    const provider = await getTokenHubProvider();
    const model = hyReasoningModel();

    model.compat = { ...model.compat, supportsStore: false };
    const highPayload = captureTencentPayload({
      provider,
      model,
      reasoning: "high",
    });
    const nonePayload = captureTencentPayload({
      provider,
      model,
      reasoning: "none",
    });

    expect(JSON.stringify(highPayload)).toBe(
      '{"model":"hy3","messages":[],"stream":true,"stream_options":{"include_usage":true},"max_completion_tokens":64000,"reasoning_effort":"high"}',
    );
    expect(JSON.stringify(nonePayload)).toBe(
      '{"model":"hy3","messages":[],"stream":true,"stream_options":{"include_usage":true},"max_completion_tokens":64000,"reasoning_effort":"none"}',
    );
  });

  it.each(["constructor"])(
    "does not treat inherited object key %s as a Tencent effort override",
    async (reasoning) => {
      const provider = await getTokenHubProvider();
      const model = hyReasoningModel();
      const payload = captureTencentPayload({ provider, model, reasoning });
      expect(payload?.reasoning_effort).toBe("none");
    },
  );

  it("collapses hy4-preview onto its two-rung ladder on both endpoints", async () => {
    const tokenHubProvider = await getTokenHubProvider();
    const tokenPlanProvider = await getTokenPlanProvider();
    const tokenHubModel = hyReasoningModel("hy4-preview");
    const tokenPlanModel = hyReasoningModel("hy4-preview", "tencent-tokenplan");

    // Preserve OpenClaw's none/high policy: intermediate efforts become high
    // and off becomes none. Raw API acceptance of low alone does not establish
    // a distinct low reasoning mode.
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
      [tokenHubProvider, tokenHubModel],
      [tokenPlanProvider, tokenPlanModel],
    ] as const) {
      for (const [reasoning, rung] of Object.entries(expected)) {
        expect(
          captureTencentPayload({ provider, model, reasoning })?.reasoning_effort,
          `${(model as { provider: string }).provider}/hy4-preview ${reasoning}`,
        ).toBe(rung);
      }
    }

    // hy3-preview keeps its three-rung ladder and stays on shared handling.
    const hy3PreviewModel = hyReasoningModel("hy3-preview");
    expect(
      captureTencentPayload({
        provider: tokenHubProvider,
        model: hy3PreviewModel,
        reasoning: "low",
      })?.reasoning_effort,
    ).toBe("low");
  });
});
