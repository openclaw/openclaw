import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { expect, it } from "vitest";
import plugin from "./index.js";

const gmiModel: Omit<Model<"openai-completions">, "id" | "name"> = {
  provider: "gmi",
  api: "openai-completions",
  reasoning: true,
  baseUrl: "https://api.gmi-serving.com/v1",
  input: ["text"],
  contextWindow: 128_000,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

it.each([
  ["openai/gpt-5.6-sol", "none", undefined, undefined],
  ["openai/gpt-5.6-luna", "none", undefined, undefined],
  ["openai/gpt-5.5", undefined, undefined, undefined],
  ["openai/gpt-5.4-mini", undefined, undefined, undefined],
  ["openai/gpt-5.4", "high", undefined, undefined],
  ["gpt-5.6-sol", "high", undefined, undefined],
  ["other/gpt-5.6-sol", "high", undefined, undefined],
  ["openai/gpt-5.6-sol", "none", "openclaw-openai-completions-transport", "openai-completions"],
  ["openai/gpt-5.6-sol", "high", "openai-completions", "openai-responses"],
  ["openai/gpt-5.6-sol", "high", "openai-responses", undefined],
] as const)(
  "GMI normalizes %s tool reasoning to %s (API %s, source %s) on both completion paths",
  async (id, effort, api, sourceApi) => {
    const provider = await registerSingleProviderPlugin(plugin);
    const model = { ...gmiModel, id, name: id, api: api ?? "openai-completions" };
    for (const wrap of [provider.wrapStreamFn, provider.wrapSimpleCompletionStreamFn]) {
      for (const tools of [
        undefined,
        [],
        [{ name: "ping", description: "Ping", parameters: { type: "object", properties: {} } }],
      ]) {
        let payload: unknown;
        const streamFn: StreamFn = async (selected, messages, options) => {
          const body =
            model.api === "openai-completions" && !sourceApi
              ? buildOpenAICompletionsParams(selected, messages, { reasoningEffort: "high" })
              : {
                  model: id,
                  tools: tools?.length ? [{ type: "function" }] : tools,
                  reasoning_effort: "high",
                };
          payload = (await options?.onPayload?.(body, selected)) ?? body;
          const stream = createAssistantMessageEventStream();
          stream.end();
          return stream;
        };
        const wrapped = wrap?.({ provider: "gmi", modelId: id, model, sourceApi, streamFn });
        if (!wrapped) {
          throw new Error("Expected GMI completion wrapper");
        }
        expect(wrapped).toHaveProperty("preservesGenericCompatibility", true);
        await wrapped(model, {
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
          expect(payload).toHaveProperty("tools", [expect.objectContaining({ type: "function" })]);
        }
      }
    }
  },
);

it("registers GMI Cloud as an OpenAI-compatible provider", async () => {
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider).toMatchObject({
    id: "gmi",
    aliases: ["gmi-cloud", "gmicloud"],
    envVars: ["GMI_API_KEY"],
    auth: [{ id: "api-key", starterModel: "gmi/openai/gpt-5.6-sol" }],
  });

  const result = await provider.staticCatalog?.run({
    config: {},
    env: {},
    resolveProviderApiKey: () => ({}),
  } as never);
  const catalogProvider = result && "provider" in result ? result.provider : undefined;
  expect(catalogProvider?.baseUrl).toBe("https://api.gmi-serving.com/v1");
  expect(catalogProvider?.models?.map((model) => model.id)).toContain("openai/gpt-5.6-sol");
});
