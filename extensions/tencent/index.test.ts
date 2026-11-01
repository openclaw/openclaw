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
import { assert, describe, expect, it, vi } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import { buildTokenHubProvider, buildTokenPlanProvider } from "./api.js";
import tencentPlugin from "./index.js";

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
  const catalog = (
    provider === "tencent-tokenhub" ? buildTokenHubProvider : buildTokenPlanProvider
  )();
  return {
    ...catalog.models[0],
    provider,
    id,
    api: "openai-completions",
    baseUrl: catalog.baseUrl,
    compat: {
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
  assert(wrapped, "expected Tencent provider stream wrapper");
  void wrapped(model, { messages: [] } as never, { reasoning } as never);
  return captured;
}

describe("tencent provider plugin", () => {
  it.each([
    ["tokenhub", "TokenHub", buildTokenHubProvider, ["hy4-preview", "hy3", "hy3-preview"]],
    ["tokenplan", "TokenPlan", buildTokenPlanProvider, ["hy4-preview", "hy3"]],
  ] as const)(
    "%s auth preserves merge rows and configures its provider in replace mode",
    async (endpoint, label, build, modelIds) => {
      const providerId = `tencent-${endpoint}` as const;
      const choiceId = `${endpoint}-api-key`;
      const { providers } = await registerTencentPlugin();
      const resolved = resolveProviderPluginChoice({ providers, choice: choiceId });
      expect(resolved?.provider.id).toBe(providerId);
      const run = resolved?.method.runNonInteractive;
      assert(run, "expected Tencent noninteractive auth method");
      const resolveApiKey = vi.fn(async () => ({
        key: "stored-test-key",
        source: "profile" as const,
      }));
      const toApiKeyCredential = vi.fn(() => null);
      const apply = (config: OpenClawConfig, opts = {}) =>
        run({
          authChoice: choiceId,
          config,
          baseConfig: config,
          opts,
          runtime: createRuntimeEnv(),
          resolveApiKey,
          toApiKeyCredential,
        });
      expect((await apply({}))?.models?.providers?.[providerId]?.models).toEqual([]);
      const provider = build();
      // Authored config rows cannot carry the catalog-only family.
      const { family: _family, ...model } = provider.models[0]!;
      const authored = [{ ...model, id: "operator-model" }];
      const result = await apply({
        models: { mode: "merge", providers: { [providerId]: { ...provider, models: authored } } },
      });
      expect(result?.models?.providers?.[providerId]?.models).toEqual(authored);
      const aliases = Object.fromEntries(
        modelIds.map((id) => [
          `${providerId}/${id}`,
          { alias: `${id.replace("hy", "Hy").replace("-", " ")} (${label})` },
        ]),
      );
      resolveApiKey.mockClear();
      const config = await apply(
        { models: { mode: "replace" } },
        {
          tokenhubApiKey: "tokenhub-test-key",
          tokenplanApiKey: "tokenplan-test-key",
        },
      );

      expect(resolveApiKey).toHaveBeenCalledExactlyOnceWith({
        provider: providerId,
        flagValue: `${endpoint}-test-key`,
        flagName: `--${endpoint}-api-key`,
        envVar: `${endpoint.toUpperCase()}_API_KEY`,
      });
      expect(toApiKeyCredential).not.toHaveBeenCalled();
      expect(Object.keys(config?.models?.providers ?? {})).toEqual([providerId]);
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
      assert(augmented?.[0]?.input, "expected Tencent model input modalities");
      const expectedAugmented = structuredClone(augmented);
      augmented[0].input.push("image");
      expect(await provider.augmentModelCatalog?.(context)).toEqual(expectedAugmented);
    },
  );

  it.each(["tencent-tokenhub", "tencent-tokenplan"] as const)(
    "%s preserves model-specific reasoning policy and rejects inherited overrides",
    async (providerId) => {
      const provider = await getProvider(providerId);
      for (const [id, reasoning, expected] of [
        ["hy3", "high", "high"],
        ["hy3", "none", "none"],
        ["hy3", "constructor", "none"],
        ["hy4-preview", "off", "none"],
        ["hy4-preview", "none", "none"],
        ["hy4-preview", "minimal", "high"],
        ["hy4-preview", "low", "high"],
        ["hy4-preview", "medium", "high"],
        ["hy4-preview", "high", "high"],
        ["hy4-preview", "xhigh", "high"],
        ["hy3-preview", "low", "low"],
      ] as const) {
        const model = hyReasoningModel(id, providerId);
        expect(
          capturePayload(provider, model, reasoning)?.reasoning_effort,
          `${id}/${reasoning}`,
        ).toBe(expected);
      }
    },
  );
});
