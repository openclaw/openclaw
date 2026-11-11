import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-onboard";
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { makeTextToolResult } from "../test-support/message-fixtures.test-support.js";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import basetenPlugin from "./index.js";

export async function registerModel(
  modelId: string,
  options?: Parameters<typeof runSingleProviderCatalog>[1],
  authoredModel?: ModelDefinitionConfig,
) {
  const provider = await registerSingleProviderPlugin(basetenPlugin);
  const catalog = await runSingleProviderCatalog(provider, options);
  const definition = authoredModel ?? catalog.models.find((model) => model.id === modelId);
  if (!definition) {
    throw new Error(`Baseten catalog omitted ${modelId}`);
  }
  const model: Model<"openai-completions"> = {
    ...definition,
    input: definition.input.filter((kind) => kind === "text" || kind === "image"),
    provider: provider.id,
    api: "openai-completions",
    baseUrl: catalog.baseUrl,
  };
  return { provider, model };
}

export function toolReplayMessages(name: string): Context["messages"] {
  return [
    { role: "user", content: `Call ${name}.`, timestamp: 0 },
    makeAgentAssistantMessage({
      api: "openai-completions",
      provider: "openai",
      model: "other-model",
      content: [{ type: "toolCall", id: "call_1", name, arguments: { value: "replay" } }],
      stopReason: "toolUse",
      timestamp: 1,
    }),
    makeTextToolResult("call_1", name, "ok", false, 2),
  ];
}
