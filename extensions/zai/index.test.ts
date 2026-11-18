import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

function expectFields(model: unknown, fields: Record<string, unknown>) {
  expect(model).toEqual(expect.objectContaining(fields));
}

const modelFields = {
  provider: "zai",
  api: "openai-completions",
  baseUrl: "https://api.z.ai/api/paas/v4",
  reasoning: true,
  input: ["text"],
} as const;
const createGlm47Template = (): Model<"openai-completions"> => ({
  ...modelFields,
  id: "glm-4.7",
  name: "GLM-4.7",
  input: ["text"],
  cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
  contextWindow: 204800,
  maxTokens: 131072,
});

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

async function createStreamCapture(
  params: Pick<ProviderWrapStreamFnContext, "extraParams" | "thinkingLevel"> & {
    modelId?: string;
  } = {},
  direct = false,
) {
  const provider = await registerSingleProviderPlugin(plugin);
  const modelId = params.modelId ?? "glm-5.1";
  let payload: Record<string, unknown> = {};
  const streamFn: StreamFn = (model, streamContext, options) => {
    payload = buildOpenAICompletionsParams(
      model,
      streamContext,
      direct ? (options ?? {}) : { reasoning: "high" },
    );
    options?.onPayload?.(payload, model);
    return {} as ReturnType<StreamFn>;
  };
  const wrap = direct ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
  const wrapped = wrap?.({
    provider: "zai",
    modelId,
    extraParams: {},
    ...params,
    streamFn,
  });
  if (!wrapped) {
    throw new Error("Expected Z.AI stream wrapper");
  }
  return (context: Context = { messages: [] }, options: Parameters<StreamFn>[2] = {}) => {
    void wrapped({ ...createGlm47Template(), id: modelId }, context, options);
    return payload;
  };
}

describe("zai provider plugin", () => {
  it("uses catalog metadata over the template and honors a custom endpoint", async () => {
    const baseUrl = "https://proxy.example.test/zai";
    expectFields(await resolveModel("glm-5.3-flash", baseUrl), {
      ...modelFields,
      id: "glm-5.3-flash",
      baseUrl,
      input: ["text", "image"],
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
    });
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

  it("keeps older GLM models' thinking binary", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    expect(
      provider.resolveThinkingProfile?.({
        provider: "zai",
        modelId: "glm-5.1",
        reasoning: true,
      } as never),
    ).toEqual({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "on" },
      ],
      defaultLevel: "off",
    });
  });

  it("applies Z.AI effort policy to each direct completion request", async () => {
    for (const modelId of ["glm-5.3", "glm-5.2", "glm-5.1"]) {
      const capture = await createStreamCapture({ modelId }, true);
      for (const reasoning of [undefined, "off", "low", "high", "max"] as const) {
        const payload = capture(undefined, { reasoning });
        expect(payload.tool_stream).toBe(true);
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

  it("does not enable preserved thinking by default", async () => {
    const withoutPreserve = (await createStreamCapture({ thinkingLevel: "low" }))();
    expect(withoutPreserve).not.toHaveProperty("thinking");
  });

  it.each(["preserveThinking", "preserve_thinking"])("preserves replay with %s", async (key) => {
    const capture = await createStreamCapture({
      extraParams: { [key]: true },
      thinkingLevel: "low",
    });
    const payload = capture({
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
        }),
        { role: "user", content: "continue", timestamp: 3 },
      ],
    });
    expect(payload.tool_stream).toBe(true);
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
    expect(prepare({})).toEqual({ tool_stream: true });
    expect(prepare({ tool_stream: false })).toEqual({ tool_stream: false });
  });
});
