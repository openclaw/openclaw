import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

function createGmiModel(id: string): Model<"openai-completions"> {
  return {
    provider: "gmi",
    api: "openai-completions",
    id,
    name: id,
    reasoning: true,
    baseUrl: "https://api.gmi-serving.com/v1",
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

describe("gmi provider plugin", () => {
  it("normalizes OpenAI tool reasoning on both completion paths without changing other requests", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    for (const [id, effort] of [
      ["openai/gpt-5.6-sol", "none"],
      ["openai/gpt-5.6-luna", "none"],
      ["openai/gpt-5.5", undefined],
      ["openai/gpt-5.4-mini", undefined],
      ["openai/gpt-5.4", "high"],
      ["gpt-5.6-sol", "high"],
      ["other/gpt-5.6-sol", "high"],
    ] as const) {
      const model = createGmiModel(id);
      for (const wrap of [provider.wrapStreamFn, provider.wrapSimpleCompletionStreamFn]) {
        for (const tools of [
          undefined,
          [],
          [{ name: "ping", description: "Ping", parameters: { type: "object", properties: {} } }],
        ]) {
          let payload: unknown;
          const baseStreamFn: StreamFn = async (selected, context, options) => {
            const request = buildOpenAICompletionsParams(selected, context, {
              reasoningEffort: "high",
            });
            payload = (await options?.onPayload?.(request, selected)) ?? request;
            const stream = createAssistantMessageEventStream();
            stream.end();
            return stream;
          };
          const streamFn =
            wrap?.({ provider: "gmi", modelId: id, model, streamFn: baseStreamFn }) ?? baseStreamFn;
          await streamFn(model, {
            messages: [{ role: "user", content: "Ping", timestamp: 0 }],
            tools,
          });
          const expected = tools?.length ? effort : "high";
          if (expected === undefined) {
            expect(payload).not.toHaveProperty("reasoning_effort");
          } else {
            expect(payload).toHaveProperty("reasoning_effort", expected);
          }
          expect(payload).toHaveProperty("model", id);
          if (tools?.length) {
            expect(payload).toHaveProperty("tools", [
              expect.objectContaining({ type: "function" }),
            ]);
          }
        }
      }
    }
  });

  it("uses the source wire API for dispatch aliases and preserves shared compatibility", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    for (const [api, sourceApi, effort] of [
      ["openclaw-openai-completions-transport", "openai-completions", "none"],
      ["openai-completions", "openai-responses", "high"],
      ["openai-responses", undefined, "high"],
    ] as const) {
      const model = { ...createGmiModel("openai/gpt-5.6-sol"), api };
      for (const wrap of [provider.wrapStreamFn, provider.wrapSimpleCompletionStreamFn]) {
        const payload = {
          model: model.id,
          tools: [{ type: "function", function: { name: "ping" } }],
          reasoning_effort: "high",
        };
        const baseStreamFn: StreamFn = async (selected, _context, options) => {
          await options?.onPayload?.(payload, selected);
          const stream = createAssistantMessageEventStream();
          stream.end();
          return stream;
        };
        const streamFn = wrap?.({
          provider: "gmi",
          modelId: model.id,
          model,
          sourceApi,
          streamFn: baseStreamFn,
        });
        if (!streamFn) {
          throw new Error("Expected GMI completion wrapper");
        }
        expect(streamFn).toHaveProperty("preservesGenericCompatibility", true);
        await streamFn(model, { messages: [] });
        expect(payload.reasoning_effort).toBe(effort);
      }
    }
  });

  it("registers GMI Cloud as an OpenAI-compatible provider", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.id).toBe("gmi");
    expect(provider.aliases).toEqual(["gmi-cloud", "gmicloud"]);
    expect(provider.envVars).toEqual(["GMI_API_KEY"]);
    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key"]);
    expect(provider.auth?.[0]?.starterModel).toBe("gmi/openai/gpt-5.6-sol");

    const result = await provider.staticCatalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({}),
    } as never);
    const catalogProvider = result && "provider" in result ? result.provider : undefined;
    expect(catalogProvider?.baseUrl).toBe("https://api.gmi-serving.com/v1");
    expect(catalogProvider?.models?.map((model) => model.id)).toContain("openai/gpt-5.6-sol");
  });
});
