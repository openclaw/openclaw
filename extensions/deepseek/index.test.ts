import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-auth-choice.runtime.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import deepseekPlugin from "./index.js";
import { DEEPSEEK_DEFAULT_MODEL_REF } from "./onboard.js";

describe("deepseek provider plugin", () => {
  const deepSeekV4ThinkingProfile = {
    levels: [
      { id: "off", label: "off" },
      { id: "low", label: "on" },
    ],
    defaultLevel: "off",
  };

  it("registers DeepSeek with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "deepseek-api-key",
    });

    expect(provider.id).toBe("deepseek");
    expect(provider.label).toBe("DeepSeek");
    expect(provider.envVars).toEqual(["DEEPSEEK_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    expect(resolved).not.toBeNull();
    expect(resolved?.provider.id).toBe("deepseek");
    expect(resolved?.method.id).toBe("api-key");
    expect(DEEPSEEK_DEFAULT_MODEL_REF).toBe("deepseek/deepseek-v4-flash");
  });

  it("builds the static DeepSeek model catalog", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);
    const catalogProvider = await runSingleProviderCatalog(provider);

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://api.deepseek.com");
    expect(catalogProvider.models?.map((model) => model.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-chat",
      "deepseek-reasoner",
    ]);
    expect(catalogProvider.models?.find((model) => model.id === "deepseek-v4-flash")).toMatchObject(
      {
        name: "DeepSeek V4 Flash",
        reasoning: true,
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        cost: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 },
        compat: {
          supportsReasoningEffort: false,
          supportsUsageInStreaming: true,
          maxTokensField: "max_tokens",
        },
      },
    );
    expect(
      catalogProvider.models?.find((model) => model.id === "deepseek-reasoner")?.reasoning,
    ).toBe(true);
  });

  it("advertises binary thinking controls for DeepSeek V4 models", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);

    expect(
      provider.resolveThinkingProfile?.({ provider: "deepseek", modelId: "deepseek-v4-flash" }),
    ).toEqual(deepSeekV4ThinkingProfile);
    expect(
      provider.resolveThinkingProfile?.({ provider: "deepseek", modelId: "deepseek-v4-pro" }),
    ).toEqual(deepSeekV4ThinkingProfile);
    expect(
      provider.resolveThinkingProfile?.({ provider: "deepseek", modelId: "deepseek-reasoner" }),
    ).toEqual({
      levels: [{ id: "low", label: "on" }],
      defaultLevel: "low",
    });
    expect(
      provider.resolveThinkingProfile?.({ provider: "deepseek", modelId: "deepseek-chat" }),
    ).toEqual({
      levels: [{ id: "off", label: "off" }],
      defaultLevel: "off",
    });
  });

  it("maps thinking controls to the DeepSeek thinking payload", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);
    let capturedPayload: Record<string, unknown> | undefined;
    let payloadSeed: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload = { model: model.id, ...payloadSeed } as Record<string, unknown>;
      payloadSeed = undefined;
      options?.onPayload?.(payload as never, model as never);
      capturedPayload = payload;
      return {} as never;
    };

    const offStream = provider.wrapStreamFn?.({
      streamFn: baseStreamFn,
      thinkingLevel: "off",
    } as never);
    await offStream?.(
      { api: "openai-completions", id: "deepseek-v4-flash" } as never,
      {} as never,
      {},
    );
    expect(capturedPayload).toMatchObject({ thinking: { type: "disabled" } });

    payloadSeed = { tool_choice: "required" };
    const onStream = provider.wrapStreamFn?.({
      streamFn: baseStreamFn,
      thinkingLevel: "low",
    } as never);
    await onStream?.(
      { api: "openai-completions", id: "deepseek-v4-flash" } as never,
      {} as never,
      {},
    );
    expect(capturedPayload).toMatchObject({
      thinking: { type: "enabled" },
      tool_choice: "required",
    });

    const reasonerStream = provider.wrapStreamFn?.({
      streamFn: baseStreamFn,
      modelId: "deepseek-reasoner",
      thinkingLevel: "off",
      extraParams: { thinking: { type: "disabled" } },
    } as never);
    await reasonerStream?.(
      { api: "openai-completions", id: "deepseek-reasoner" } as never,
      {} as never,
      {},
    );
    expect(capturedPayload).toMatchObject({ thinking: { type: "enabled" } });

    payloadSeed = { thinking: { type: "enabled" } };
    const chatStream = provider.wrapStreamFn?.({
      streamFn: baseStreamFn,
      modelId: "deepseek-chat",
      thinkingLevel: "low",
      extraParams: { thinking: { type: "enabled" } },
    } as never);
    await chatStream?.(
      { api: "openai-completions", id: "deepseek-chat" } as never,
      {} as never,
      {},
    );
    expect(capturedPayload).toEqual({ model: "deepseek-chat" });
  });

  it("publishes configured DeepSeek models through plugin-owned catalog augmentation", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);

    expect(
      provider.augmentModelCatalog?.({
        config: {
          models: {
            providers: {
              deepseek: {
                models: [
                  {
                    id: "deepseek-v4-flash",
                    name: "DeepSeek V4 Flash",
                    input: ["text"],
                    reasoning: false,
                    contextWindow: 1_000_000,
                  },
                ],
              },
            },
          },
        },
      } as never),
    ).toEqual([
      {
        provider: "deepseek",
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        input: ["text"],
        reasoning: false,
        contextWindow: 1_000_000,
      },
    ]);
  });
});
