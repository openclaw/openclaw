import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

function expectFields(model: unknown, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(model).toHaveProperty(key, value);
  }
}

const modelFields = {
  provider: "zai",
  api: "openai-completions",
  baseUrl: "https://api.z.ai/api/paas/v4",
  reasoning: true,
  input: ["text"],
} as const;
function createGlm47Template(): Model<"openai-completions"> {
  return {
    ...modelFields,
    id: "glm-4.7",
    name: "GLM-4.7",
    input: ["text"],
    cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
    contextWindow: 204800,
    maxTokens: 131072,
  };
}

async function resolveModel(
  modelId: string,
  baseUrl?: string,
  template: Model<"openai-completions"> | null = createGlm47Template(),
) {
  const provider = await registerSingleProviderPlugin(plugin);
  return provider.resolveDynamicModel?.({
    provider: "zai",
    modelId,
    modelRegistry: {
      find: (_provider: string, id: string) => (id === "glm-4.7" ? template : null),
    },
    providerConfig: { baseUrl },
  } as never);
}

async function captureStreamPayload(
  params: Pick<ProviderWrapStreamFnContext, "extraParams" | "thinkingLevel"> & {
    modelId?: string;
  } = {},
  context: Context = { messages: [] },
) {
  const provider = await registerSingleProviderPlugin(plugin);
  const modelId = params.modelId ?? "glm-5.1";
  let payload: Record<string, unknown> = {};
  const streamFn: StreamFn = (model, streamContext, options) => {
    payload = buildOpenAICompletionsParams(model, streamContext, { reasoning: "high" });
    options?.onPayload?.(payload, model);
    return {} as ReturnType<StreamFn>;
  };
  const wrapped = provider.wrapStreamFn?.({
    provider: "zai",
    modelId,
    extraParams: {},
    ...params,
    streamFn,
  });
  if (!wrapped) {
    throw new Error("Expected Z.AI stream wrapper");
  }
  void wrapped({ ...createGlm47Template(), id: modelId }, context, {});
  return payload;
}

describe("zai provider plugin", () => {
  it("resolves persisted GLM-5 metadata through selected provider endpoints", async () => {
    const global = "https://api.z.ai/api/paas/v4";
    const billedCost = { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 };
    const turboCost = { input: 1.2, output: 4, cacheRead: 0.24, cacheWrite: 0 };
    const codingCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const flashCost = { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 };
    const coding = "https://api.z.ai/api/coding/paas/v4";
    const codingCn = "https://open.bigmodel.cn/api/coding/paas/v4";
    const cases = [
      ["glm-5.3", coding, ["text"], 1_048_576, codingCost],
      ["glm-5.3-flash", codingCn, ["text", "image"], 1_048_576, flashCost],
      ["glm-5.2", "https://proxy.example.test/zai", ["text"], 1_000_000, billedCost],
      ["glm-5.1", global, ["text"], 200_000, billedCost],
      ["glm-5v-turbo", global, ["text", "image"], 200_000, turboCost],
      ["glm-5-turbo", global, ["text"], 200_000, turboCost],
    ] as const;

    for (const [modelId, baseUrl, input, contextWindow, cost] of cases) {
      expectFields(await resolveModel(modelId, baseUrl), {
        ...modelFields,
        id: modelId,
        baseUrl,
        input,
        contextWindow,
        maxTokens: 131_072,
        cost,
      });
    }
  });

  it("falls back to manifest baseUrl when both providerConfig and template model are unavailable", async () => {
    expectFields(await resolveModel("glm-5.3", undefined, null), {
      ...modelFields,
      id: "glm-5.3",
    });
  });

  it("still synthesizes unknown GLM-5 variants from the GLM-4.7 template", async () => {
    expectFields(await resolveModel("glm-5.4-preview"), {
      ...modelFields,
      id: "glm-5.4-preview",
    });
  });

  it("exposes GLM-5.3 thinking levels while keeping older GLM models binary", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const profile = (modelId: string) =>
      provider.resolveThinkingProfile?.({
        provider: "zai",
        modelId,
        reasoning: true,
      } as never);
    expect(profile("glm-5.3")).toEqual({
      levels: [
        { id: "low", label: "low" },
        { id: "high", label: "high" },
        { id: "max", label: "max" },
      ],
      defaultLevel: "max",
    });

    expect(profile("glm-5.1")).toEqual({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "on" },
      ],
      defaultLevel: "off",
    });
  });

  it("maps GLM-5.3 thinking levels to Z.AI reasoning effort", async () => {
    for (const [modelId, thinkingLevel, expectedEffort] of [
      ["glm-5.3", "off", "low"],
      ["glm-5.3", "low", "low"],
      ["glm-5.3", "high", "high"],
      ["glm-5.3", "max", "max"],
    ] as const) {
      const payload = await captureStreamPayload({ modelId, thinkingLevel });
      expect(payload.reasoning_effort).toBe(expectedEffort);
      expect(payload).not.toHaveProperty("thinking");
      expect(payload.tool_stream).toBe(true);
    }
  });

  it("applies Z.AI effort policy to each direct completion request", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    for (const modelId of ["glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1"]) {
      const model = { ...createGlm47Template(), id: modelId };
      let payload: Record<string, unknown> = {};
      const streamFn: StreamFn = (streamModel, context, options) => {
        payload = buildOpenAICompletionsParams(streamModel, context, options ?? {});
        options?.onPayload?.(payload, streamModel);
        return {} as ReturnType<StreamFn>;
      };
      const wrapped = provider.wrapSimpleCompletionStreamFn?.({
        provider: "zai",
        modelId,
        sourceApi: "openai-completions",
        streamFn,
      });
      if (!wrapped) {
        throw new Error("Expected Z.AI direct completion wrapper");
      }
      for (const reasoning of [undefined, "off", "low", "high", "max"] as const) {
        void wrapped(model, { messages: [] }, { reasoning });
        if (modelId.startsWith("glm-5.3")) {
          const effort = { off: "low", low: "low", high: "high", max: "max" };
          expect(payload.reasoning_effort).toBe(effort[reasoning ?? "max"]);
          expect(payload).not.toHaveProperty("thinking");
          expect(payload).not.toHaveProperty("enable_thinking");
        } else if (reasoning === undefined || reasoning === "off") {
          expect(payload.thinking).toEqual({ type: "disabled" });
        }
      }
    }
  });

  it("enables Z.AI preserved thinking only when requested", async () => {
    const withoutPreserve = await captureStreamPayload({ thinkingLevel: "low" });
    expect(withoutPreserve).not.toHaveProperty("thinking");
    const withPreserve = await captureStreamPayload({
      extraParams: { preserveThinking: true },
      thinkingLevel: "low",
    });
    expect(withPreserve.tool_stream).toBe(true);
    expect(withPreserve.thinking).toEqual({ type: "enabled", clear_thinking: false });
  });

  it("preserves replayed reasoning_content for Z.AI preserved thinking", async () => {
    const payload = await captureStreamPayload(
      {
        extraParams: { preserve_thinking: true },
        thinkingLevel: "low",
      },
      {
        messages: [
          { role: "user", content: "hi", timestamp: 1 },
          makeAgentAssistantMessage({
            api: "openai-completions",
            provider: "zai",
            model: "glm-5.1",
            content: [
              {
                type: "thinking",
                thinking: "prior reasoning",
                thinkingSignature: "reasoning_content",
              },
              { type: "text", text: "visible reply" },
            ],
            timestamp: 2,
          }),
          { role: "user", content: "continue", timestamp: 3 },
        ],
      },
    );
    expect(payload.thinking).toEqual({ type: "enabled", clear_thinking: false });
    expect((payload.messages as Array<Record<string, unknown>>)[1]).toMatchObject({
      role: "assistant",
      content: "visible reply",
      reasoning_content: "prior reasoning",
    });
  });

  it("defaults tool_stream extra params but preserves explicit values", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const prepare = (extraParams: Record<string, unknown>) =>
      provider.prepareExtraParams?.({
        provider: "zai",
        modelId: "glm-4.7",
        extraParams,
      } as never);
    expect(prepare({ endpoint: "global" })).toEqual({
      endpoint: "global",
      tool_stream: true,
    });

    const explicit = { endpoint: "global", tool_stream: false };
    expect(prepare(explicit)).toBe(explicit);
  });
});
