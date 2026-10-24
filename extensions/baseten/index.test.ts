import { createApiRegistry, createNodeLlmRuntime } from "@openclaw/ai";
import {
  createAssistantMessageEventStream,
  getApiProvider,
  type Context,
  type SimpleStreamOptions,
} from "openclaw/plugin-sdk/llm";
import {
  createRuntimeEnv,
  createTestWizardPrompter,
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ModelDefinitionConfig, OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { applyBasetenConfig, buildStaticBasetenModels } from "./api.js";
import { registerModel, toolReplayMessages } from "./baseten.test-support.js";
import basetenPlugin from "./index.js";

const TEST_VALUE = "resolved-marker";
async function captureRegisteredPayloads(params: {
  modelId: string;
  authoredModel?: ModelDefinitionConfig;
  thinkingLevel?: "off" | "high" | "max" | "adaptive";
  reasoningLevels: readonly ("off" | "high" | "max" | undefined)[];
  context?: Context;
}) {
  const { provider, model } = await registerModel(params.modelId, undefined, params.authoredModel);
  const captured: ReturnType<typeof buildOpenAICompletionsParams>[] = [];
  const wrapped = provider.wrapStreamFn?.({
    provider: provider.id,
    modelId: model.id,
    model,
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
    throw new Error("Baseten provider did not register a stream wrapper");
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
  it.each<[SimpleStreamOptions, string]>([
    [{ sessionId: "synthetic-session" }, "synthetic-session"],
    [
      { sessionId: "synthetic-session", headers: { "X-Session-Affinity": "caller-affinity" } },
      "caller-affinity",
    ],
  ])("sends Baseten cache affinity in the real request: %j", async (options, expected) => {
    const { provider, model } = await registerModel("deepseek-ai/DeepSeek-V4.1-Flash");
    const registry = createApiRegistry();
    const completions = getApiProvider("openai-completions");
    if (!completions) {
      throw new Error("expected built-in Chat Completions adapter");
    }
    registry.registerApiProvider(completions);
    let sentHeaders: Headers | undefined;
    const runtime = createNodeLlmRuntime(registry, {
      buildModelFetch: () => async (_url, init) => {
        sentHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ error: { message: "synthetic request captured" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const wrapped = provider.wrapStreamFn?.({
      provider: model.provider,
      modelId: model.id,
      model,
      streamFn: runtime.streamSimple,
    });
    if (!wrapped) {
      throw new Error("expected registered Baseten stream wrapper");
    }
    const result = await (
      await wrapped(
        model,
        { messages: [{ role: "user", content: "Synthetic question", timestamp: 1 }] },
        { ...options, apiKey: "synthetic-unused-key" },
      )
    ).result();
    expect(result.errorMessage).toContain("synthetic request captured");
    expect(sentHeaders).toBeDefined();
    expect(sentHeaders?.get("x-session-affinity")).toBe(expected);
  });

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
        expect(output?.models?.providers?.baseten?.models).toHaveLength(mode === "replace" ? 6 : 0);
        expect(output?.agents?.defaults?.models).toEqual({
          "baseten/deepseek-ai/DeepSeek-V4.1-Flash": { alias: "DeepSeek V4.1 Flash" },
        });
      }
      expect(applyBasetenConfig(config).models?.providers?.baseten?.models).toHaveLength(6);
    },
  );

  it("uses per-call thinking and the factory default through one registered wrapper", async () => {
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
      });
      expect(payloads.map((p) => [p.chat_template_args, p.reasoning_effort])).toEqual([
        [{ preserve_me: true, enable_thinking: false }, "none"],
        [{ preserve_me: true, enable_thinking: true }, "max"],
        [{ preserve_me: true, enable_thinking: defaultEffort !== "none" }, defaultEffort],
      ]);
    }
  });

  it.each([false, true])(
    "normalizes DeepSeek replay per call (authored legacy=%s)",
    async (legacy) => {
      const current = buildStaticBasetenModels().find(
        (model) => model.id === "deepseek-ai/DeepSeek-V4-Pro-0813",
      );
      if (!current) {
        throw new Error("Current DeepSeek Pro metadata missing");
      }
      const modelId = legacy ? "deepseek-ai/DeepSeek-V4-Pro" : current.id;
      const payloads = await captureRegisteredPayloads({
        modelId,
        authoredModel: legacy ? { ...current, id: modelId } : undefined,
        reasoningLevels: ["off", "max", undefined],
        context: {
          tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
          messages: [
            ...toolReplayMessages("read"),
            makeAgentAssistantMessage({
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
              timestamp: 3,
            }),
          ],
        },
      });

      expect(payloads.map((payload) => payload.reasoning_effort)).toEqual(["none", "max", "high"]);
      for (const [index, payload] of payloads.entries()) {
        expect(payload.model).toBe(modelId);
        expect(payload.chat_template_args).toEqual({ preserve_me: true });
        expect(payload.thinking).toEqual(
          legacy ? undefined : { type: index === 0 ? "disabled" : "enabled" },
        );
        if (index === 0) {
          expect(payload.messages).not.toContainEqual(
            expect.objectContaining({ reasoning_content: expect.any(String) }),
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
    const profile = (modelId: string) =>
      provider.resolveThinkingProfile?.({ provider: "baseten", modelId, reasoning: true } as never);
    const deepseekLevels = [{ id: "off" }, { id: "low" }, { id: "high" }, { id: "max" }];
    const glmProfile = {
      levels: [{ id: "off" }, { id: "high" }, { id: "max" }],
      defaultLevel: "off",
    };
    for (const [modelId, expected] of [
      ["deepseek-ai/DeepSeek-V4.1-Flash", { levels: deepseekLevels, defaultLevel: "high" }],
      ["deepseek-ai/DeepSeek-V4-Pro-0813", { levels: deepseekLevels }],
      [
        "moonshotai/Kimi-K2.6",
        {
          levels: [{ id: "off" }, { id: "low", label: "on" }],
          defaultLevel: "off",
        },
      ],
      ["zai-org/GLM-5.2", glmProfile],
      ["zai-org/GLM-5.2-Fast", glmProfile],
      ["thinkingmachines/inkling", undefined],
    ] as const) {
      expect(profile(modelId), modelId).toEqual(expected);
    }
  });
});
