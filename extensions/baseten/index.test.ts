import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import {
  createRuntimeEnv,
  createTestWizardPrompter,
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
  type ModelDefinitionConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import { applyBasetenConfig } from "./api.js";
import basetenPlugin from "./index.js";

const TEST_VALUE = "resolved-marker";

async function captureRegisteredPayloads(params: {
  modelId: string;
  thinkingLevel?: "off" | "high" | "max" | "adaptive";
  reasoningLevels: readonly ("off" | "high" | "max" | undefined)[];
  simple?: boolean;
  context?: Context;
}) {
  const provider = await registerSingleProviderPlugin(basetenPlugin);
  const catalog = await runSingleProviderCatalog(provider);
  const catalogModel = catalog.models.find((model) => model.id === params.modelId);
  if (!catalogModel) {
    throw new Error(`Baseten catalog did not provide ${params.modelId}`);
  }
  const model: Model = {
    ...catalogModel,
    input: catalogModel.input.filter((kind) => kind === "text" || kind === "image"),
    provider: provider.id,
    api: params.simple
      ? `openclaw-provider-stream:baseten:${params.modelId}`
      : "openai-completions",
    baseUrl: catalog.baseUrl,
  };
  const captured: ReturnType<typeof buildOpenAICompletionsParams>[] = [];
  const wrap = params.simple ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
  const wrapped = wrap?.({
    provider: provider.id,
    modelId: model.id,
    model,
    sourceApi: params.simple ? "openai-completions" : undefined,
    thinkingLevel: params.thinkingLevel,
    streamFn: (streamModel, context, options) => {
      const payload = buildOpenAICompletionsParams(
        { ...streamModel, api: "openai-completions" },
        context,
        {
          reasoning: options?.reasoning === "off" ? "none" : options?.reasoning,
          maxTokens: 32,
        },
      );
      payload.chat_template_args = { preserve_me: true };
      options?.onPayload?.(payload, streamModel);
      captured.push(payload);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.end());
      return stream;
    },
  });
  if (!wrapped) {
    throw new Error(
      `Baseten provider did not register a ${params.simple ? "simple completion" : "stream"} wrapper`,
    );
  }
  for (const reasoning of params.reasoningLevels) {
    await wrapped(
      model,
      params.context ?? { messages: [] },
      reasoning === undefined ? {} : { reasoning },
    );
  }
  return captured;
}

describe("Baseten provider registration", () => {
  it.each([undefined, "replace"] as const)(
    "keeps registered %s setup separate from the public catalog preset",
    async (mode) => {
      const provider = await registerSingleProviderPlugin(basetenPlugin);
      const method = resolveProviderPluginChoice({
        providers: [provider],
        choice: "baseten-api-key",
      })?.method;
      if (!method?.runNonInteractive) {
        throw new Error("expected Baseten noninteractive auth method");
      }
      const config: OpenClawConfig = { models: { mode } };
      const interactive = await method.run({
        config,
        env: {},
        opts: { basetenApiKey: TEST_VALUE },
        runtime: createRuntimeEnv(),
        prompter: createTestWizardPrompter(),
        secretInputMode: "plaintext",
        isRemote: false,
        openUrl: vi.fn(),
        oauth: { createVpsAwareHandlers: vi.fn() },
      });
      const noninteractive = await method.runNonInteractive({
        authChoice: "baseten-api-key",
        opts: {},
        config,
        baseConfig: config,
        runtime: createRuntimeEnv(),
        resolveApiKey: async () => ({ key: TEST_VALUE, source: "profile" }),
        toApiKeyCredential: () => null,
      });

      for (const output of [interactive.configPatch, noninteractive]) {
        expect(output?.models?.providers?.baseten).toMatchObject({
          baseUrl: "https://inference.baseten.co/v1",
          api: "openai-completions",
        });
        expect(output?.models?.providers?.baseten?.models).toHaveLength(mode === "replace" ? 9 : 0);
        expect(output?.agents?.defaults?.models).toEqual({
          "baseten/thinkingmachines/inkling": { alias: "Inkling" },
        });
      }
      expect(applyBasetenConfig(config).models?.providers?.baseten?.models).toHaveLength(9);
    },
  );

  it.each(["merge", "replace"] as const)(
    "preserves authored rows and aliases when repeating registered %s setup",
    async (mode) => {
      const provider = await registerSingleProviderPlugin(basetenPlugin);
      const run = resolveProviderPluginChoice({
        providers: [provider],
        choice: "baseten-api-key",
      })?.method.runNonInteractive;
      if (!run) {
        throw new Error("expected Baseten noninteractive auth method");
      }
      const authoredDefault: ModelDefinitionConfig = {
        id: "thinkingmachines/inkling",
        name: "Authored default",
        reasoning: false,
        input: ["text"],
        contextWindow: 8192,
        maxTokens: 1024,
        cost: { input: 7, output: 9, cacheRead: 1, cacheWrite: 2 },
      };
      const authoredModels = [
        authoredDefault,
        { ...authoredDefault, id: "operator-only", name: "Authored selection" },
      ];
      const input: OpenClawConfig = {
        models: {
          mode,
          providers: {
            baseten: { baseUrl: "https://operator.invalid/v1", models: authoredModels },
          },
        },
        agents: {
          defaults: {
            model: { primary: "fixture/primary", fallbacks: ["fixture/fallback"] },
            models: { "baseten/thinkingmachines/inkling": { alias: "Saved alias" } },
          },
        },
      };
      const original = structuredClone(input);
      const authenticate = (config: OpenClawConfig) =>
        run({
          authChoice: "baseten-api-key",
          opts: {},
          config,
          baseConfig: config,
          runtime: createRuntimeEnv(),
          resolveApiKey: async () => ({ key: TEST_VALUE, source: "profile" }),
          toApiKeyCredential: () => null,
        });
      const first = await authenticate(input);
      if (!first) {
        throw new Error("expected configured Baseten provider");
      }
      const second = await authenticate(first);

      for (const output of [first, second]) {
        expect(output?.models?.providers?.baseten?.models).toEqual(
          expect.arrayContaining(authoredModels),
        );
        expect(output?.models?.providers?.baseten?.models).toHaveLength(
          mode === "replace" ? 10 : 2,
        );
        expect(output?.agents?.defaults?.models).toEqual(original.agents?.defaults?.models);
        expect(resolveAgentModelPrimaryValue(output?.agents?.defaults?.model)).toBe(
          "baseten/thinkingmachines/inkling",
        );
        expect(resolveAgentModelFallbackValues(output?.agents?.defaults?.model)).toEqual([
          "fixture/fallback",
        ]);
      }
      expect(input).toEqual(original);
    },
  );

  it("registers authenticated live and network-free static catalogs", async () => {
    const provider = await registerSingleProviderPlugin(basetenPlugin);
    const choice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "baseten-api-key",
    });
    const catalog = await runSingleProviderCatalog(provider, {
      resolveProviderAuth: () => ({
        apiKey: TEST_VALUE,
        discoveryApiKey: undefined,
        mode: "api_key",
        source: "env",
      }),
    });

    expect(provider).toMatchObject({
      id: "baseten",
      label: "Baseten",
      docsPath: "/providers/baseten",
      envVars: ["BASETEN_API_KEY"],
      resolveDynamicModel: expect.any(Function),
      resolveThinkingProfile: expect.any(Function),
      wrapStreamFn: expect.any(Function),
    });
    expect(choice?.provider.id).toBe("baseten");
    expect(choice?.method.id).toBe("api-key");
    expect(resolveAgentModelPrimaryValue(applyBasetenConfig({}).agents?.defaults?.model)).toBe(
      "baseten/thinkingmachines/inkling",
    );
    expect(catalog).toMatchObject({
      apiKey: TEST_VALUE,
      baseUrl: "https://inference.baseten.co/v1",
      api: "openai-completions",
    });
    expect(catalog.models).toHaveLength(9);
    expect(provider.staticCatalog).toBeDefined();
    expect(
      provider.buildReplayPolicy?.({
        modelApi: "openai-completions",
        modelId: "deepseek-ai/DeepSeek-V4-Pro",
      } as never)?.dropReasoningFromHistory,
    ).not.toBe(true);
  });

  it("preserves Inkling max effort through the registered catalog and stream payload", async () => {
    const [payload] = await captureRegisteredPayloads({
      modelId: "thinkingmachines/inkling",
      thinkingLevel: "max",
      reasoningLevels: ["max"],
    });
    expect(payload?.reasoning_effort).toBe("max");
    expect(payload?.chat_template_args).toEqual({ preserve_me: true });
  });

  it("enables binary thinking through the registered simple completion hook", async () => {
    const [payload] = await captureRegisteredPayloads({
      modelId: "moonshotai/Kimi-K2.6",
      thinkingLevel: "high",
      reasoningLevels: ["high"],
      simple: true,
    });
    expect(payload?.chat_template_args).toEqual({
      preserve_me: true,
      enable_thinking: true,
    });
  });

  it.each([false, true])(
    "uses per-call thinking and the factory default through one registered wrapper (simple=%s)",
    async (simple) => {
      for (const [thinkingLevel, defaultEffort] of [
        [undefined, "none"],
        ["off", "none"],
        ["high", "high"],
        ["adaptive", "max"],
      ] as const) {
        const payloads = await captureRegisteredPayloads({
          modelId: "zai-org/GLM-5.2",
          thinkingLevel,
          reasoningLevels: ["off", "max", undefined],
          simple,
        });
        expect(payloads.map((payload) => payload.chat_template_args)).toEqual([
          { preserve_me: true, enable_thinking: false },
          { preserve_me: true, enable_thinking: true },
          { preserve_me: true, enable_thinking: defaultEffort !== "none" },
        ]);
        expect(payloads.map((payload) => payload.reasoning_effort)).toEqual([
          "none",
          "max",
          defaultEffort,
        ]);
      }
    },
  );

  it.each([false, true])(
    "normalizes DeepSeek replay per call through one registered wrapper (simple=%s)",
    async (simple) => {
      const modelId = "deepseek-ai/DeepSeek-V4-Pro";
      const payloads = await captureRegisteredPayloads({
        modelId,
        reasoningLevels: ["off", "max", undefined],
        simple,
        context: {
          messages: [
            { role: "user", content: "Read the fixture.", timestamp: 0 },
            {
              role: "assistant",
              api: "openai-completions",
              provider: "other-provider",
              model: "other-model",
              content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
              usage: createZeroUsageFixture(),
              stopReason: "toolUse",
              timestamp: 1,
            },
            {
              role: "toolResult",
              toolCallId: "call_1",
              toolName: "read",
              content: [{ type: "text", text: "ok" }],
              isError: false,
              timestamp: 2,
            },
            {
              role: "assistant",
              api: "openai-completions",
              provider: "baseten",
              model: modelId,
              content: [
                {
                  type: "thinking",
                  thinking: "preserve me",
                  thinkingSignature: "reasoning_content",
                },
                { type: "text", text: "done" },
              ],
              usage: createZeroUsageFixture(),
              stopReason: "stop",
              timestamp: 3,
            },
          ],
        },
      });

      expect(payloads.map((payload) => payload.reasoning_effort)).toEqual(["none", "max", "high"]);
      for (const [index, payload] of payloads.entries()) {
        if (index === 0) {
          expect(payload.messages).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({ reasoning_content: expect.any(String) }),
            ]),
          );
        } else {
          expect(payload.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                role: "assistant",
                tool_calls: expect.any(Array),
                reasoning_content: "",
              }),
              expect.objectContaining({
                role: "assistant",
                content: "done",
                reasoning_content: "preserve me",
              }),
            ]),
          );
        }
      }
    },
  );

  it("exposes opt-in thinking without duplicate reasoning levels", async () => {
    const provider = await registerSingleProviderPlugin(basetenPlugin);

    expect(
      provider.resolveThinkingProfile?.({
        provider: "baseten",
        modelId: "moonshotai/Kimi-K2.6",
        reasoning: true,
      } as never),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low", label: "on" }],
      defaultLevel: "off",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "baseten",
        modelId: "zai-org/GLM-5.2",
        reasoning: true,
      } as never),
    ).toEqual({
      levels: [{ id: "off" }, { id: "high" }, { id: "max" }],
      defaultLevel: "off",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "baseten",
        modelId: "zai-org/GLM-5.2-Fast",
        reasoning: true,
      } as never),
    ).toEqual({
      levels: [{ id: "off" }, { id: "high" }, { id: "max" }],
      defaultLevel: "off",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "baseten",
        modelId: "thinkingmachines/inkling",
        reasoning: true,
      } as never),
    ).toBeUndefined();
  });
});
