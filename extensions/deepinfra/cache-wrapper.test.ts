import { buildOpenAICompletionsParams } from "@openclaw/ai/transports";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import deepinfraPlugin from "./index.js";

function makeModel(id: string): Model<"openai-completions"> {
  return {
    api: "openai-completions",
    id,
    provider: "deepinfra",
    name: "Synthetic model",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

const conversation = (content: unknown, user: unknown = "Hi") => ({
  messages: [
    { role: "system", content },
    { role: "user", content: user },
  ],
});
const cachedText = (text: string) => ({
  type: "text",
  text,
  cache_control: { type: "ephemeral" },
});

async function registeredWrapper(base: StreamFn, modelId: string, cacheRetention?: string) {
  const provider = await registerSingleProviderPlugin(deepinfraPlugin);
  const wrapped = provider.wrapStreamFn?.({
    provider: "deepinfra",
    modelId,
    streamFn: base,
    extraParams: { cacheRetention },
  });
  if (!wrapped) {
    throw new Error("DeepInfra stream wrapper missing");
  }
  return wrapped;
}

async function capturePayload(params: {
  modelId: string;
  api?: "openai-completions" | "anthropic-messages";
  initialPayload: Record<string, unknown>;
  cacheRetention?: "none" | "short" | "long";
}) {
  let captured: Record<string, unknown> = {};
  const base = vi.fn<StreamFn>((_model, _context, options) => {
    const payload = structuredClone(params.initialPayload);
    options?.onPayload?.(payload, _model);
    captured = payload;
    return createAssistantMessageEventStream();
  });

  const wrapped = await registeredWrapper(base, params.modelId, params.cacheRetention);
  const model = { ...makeModel(params.modelId), api: params.api ?? "openai-completions" };
  void wrapped(model, { messages: [] }, {});

  return { captured, base };
}

describe("registered DeepInfra cache wrapper", () => {
  it.each([
    {
      modelId: "Anthropic/Claude-Sonnet-4-6",
      content: "system",
      expected: [cachedText("system")],
    },
    {
      modelId: "anthropic/claude-haiku-4-5",
      content: [
        { type: "text", text: "Block one" },
        { type: "text", text: "Block two" },
      ],
      expected: [{ type: "text", text: "Block one" }, cachedText("Block two")],
    },
  ])(
    "tags the final system block and user message for $modelId",
    async ({ modelId, content, expected }) => {
      const { captured, base } = await capturePayload({
        modelId,
        initialPayload: conversation(content),
      });
      expect(base).toHaveBeenCalledOnce();
      expect(captured).toEqual(conversation(expected, [cachedText("Hi")]));
    },
  );

  it.each(["none", "long"] as const)(
    "honors configured %s retention without inventing TTL support",
    async (cacheRetention) => {
      const { captured } = await capturePayload({
        modelId: "anthropic/claude-sonnet-4-6",
        cacheRetention,
        initialPayload: conversation("system"),
      });
      expect(JSON.stringify(captured).match(/"cache_control":/g) ?? []).toHaveLength(
        cacheRetention === "none" ? 0 : 2,
      );
      expect(JSON.stringify(captured)).not.toContain('"ttl"');
    },
  );

  it.each([
    { cacheRetention: "none", requiresStringContent: false },
    { cacheRetention: "short", requiresStringContent: true },
  ] as const)(
    "composes managed requests with $cacheRetention retention and string-only=$requiresStringContent",
    async ({ cacheRetention, requiresStringContent }) => {
      const model: Model<"openai-completions"> & {
        compat: { requiresStringContent: boolean };
      } = {
        ...makeModel("anthropic/claude-sonnet-4-6"),
        compat: { requiresStringContent },
      };
      let payload: Record<string, unknown> = {};
      const base: StreamFn = (resolvedModel, context, options) => {
        payload = buildOpenAICompletionsParams(resolvedModel, context, {
          cacheRetention: options?.cacheRetention,
        });
        options?.onPayload?.(payload, resolvedModel);
        return createAssistantMessageEventStream();
      };
      const wrapped = await registeredWrapper(base, model.id, cacheRetention);
      void wrapped(model, {
        systemPrompt: "STABLE",
        messages: [{ role: "user", content: "Question", timestamp: 1 }],
      });
      expect(JSON.stringify(payload)).not.toContain("cache_control");
      expect(payload.messages).toEqual(conversation("STABLE", "Question").messages);
    },
  );

  it.each([
    {
      modelId: "anthropic/claude-sonnet-4-6",
      api: "anthropic-messages" as const,
      cacheRetention: "long" as const,
      initialPayload: {
        system: [cachedText("system")],
        messages: [{ role: "user", content: [{ type: "text", text: "question" }] }],
      },
    },
    { modelId: "deepseek-ai/DeepSeek-V4-Flash", initialPayload: conversation("sys") },
  ])("preserves payload and options for $modelId ($api)", async (params) => {
    const { captured, base } = await capturePayload(params);
    expect(base).toHaveBeenCalledOnce();
    expect(captured).toEqual(params.initialPayload);
    expect(base.mock.calls[0]?.[2]?.cacheRetention).toBeUndefined();
  });
});
