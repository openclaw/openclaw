// Requesty live tests prove model discovery, streamed text, and a tool-call round trip.
import { completeSimple, streamSimple, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { extractNonEmptyAssistantText, isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import {
  createLiveValueTool,
  requireLiveToolCall,
} from "../test-support/live-value-tool.test-support.js";
import {
  makeTextToolResult,
  makeUserMessage,
} from "../test-support/message-fixtures.test-support.js";
import {
  getStaticRequestyModelCatalog,
  REQUESTY_BASE_URL,
  REQUESTY_DEFAULT_MODEL_ID,
} from "./api.js";
import plugin from "./index.js";

const REQUESTY_API_KEY = process.env.REQUESTY_API_KEY?.trim() ?? "";
const LIVE = isLiveTestEnabled(["REQUESTY_LIVE_TEST"]) && REQUESTY_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;
const defaultModelIds = getStaticRequestyModelCatalog().map((model) => model.id);

function liveCatalogContext(): ProviderCatalogContext {
  return {
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey: REQUESTY_API_KEY }),
    resolveProviderAuth: () => ({ apiKey: REQUESTY_API_KEY, mode: "api_key", source: "profile" }),
  };
}

async function discoverLiveCatalog() {
  const provider = await registerSingleProviderPlugin(plugin);
  const result = await provider.catalog?.run(liveCatalogContext());
  if (!result || !("provider" in result)) {
    throw new Error(`Requesty live discovery failed: ${JSON.stringify(result?.outcomes)}`);
  }
  return result.provider;
}

function liveModel(id: string): Model<"openai-completions"> {
  return {
    provider: "requesty",
    baseUrl: REQUESTY_BASE_URL,
    id,
    name: id,
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  } as Model<"openai-completions">;
}

describeLive("requesty plugin live", () => {
  it("discovers the key's managed policies including all three defaults", async () => {
    const provider = await discoverLiveCatalog();
    expect(provider.models.every((model) => !model.id.includes("/"))).toBe(true);
    for (const modelId of defaultModelIds) {
      const model = provider.models.find((candidate) => candidate.id === modelId);
      expect(model, `managed default ${modelId}`).toBeDefined();
      expect(model?.cost.input).toBeGreaterThan(0);
      expect(model?.contextWindow).toBeGreaterThan(0);
    }
  }, 30_000);

  it("streams text with a thinking level through the attribution-wrapped stream", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const catalog = await discoverLiveCatalog();
    const definition = catalog.models.find((model) => model.id === REQUESTY_DEFAULT_MODEL_ID);
    if (!definition) {
      throw new Error(`Requesty live catalog did not include ${REQUESTY_DEFAULT_MODEL_ID}`);
    }
    const wrapped = provider.wrapStreamFn?.({
      provider: "requesty",
      modelId: REQUESTY_DEFAULT_MODEL_ID,
      streamFn: streamSimple,
    } as never);
    if (!wrapped) {
      throw new Error("Requesty provider did not register a stream wrapper");
    }
    let payload: Record<string, unknown> | undefined;
    const stream = await wrapped(
      { ...liveModel(REQUESTY_DEFAULT_MODEL_ID), ...definition } as Model<"openai-completions">,
      { messages: [{ role: "user", content: "Reply with exactly: ok", timestamp: Date.now() }] },
      {
        apiKey: REQUESTY_API_KEY,
        maxTokens: 2048,
        reasoning: "low",
        onPayload: (value) => {
          payload = value as Record<string, unknown>;
        },
      },
    );
    const response = await stream.result();
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage || "Requesty stream returned an error");
    }
    expect(payload?.reasoning_effort).toBe("low");
    expect(payload).not.toHaveProperty("reasoning");
    expect(extractNonEmptyAssistantText(response.content)).toMatch(/ok/i);
  }, 60_000);

  it.each(defaultModelIds)(
    "completes a tool-call round trip with %s",
    async (modelId) => {
      const catalog = await discoverLiveCatalog();
      const definition = catalog.models.find((candidate) => candidate.id === modelId);
      if (!definition) {
        throw new Error(`Requesty live catalog did not include ${modelId}`);
      }
      const model = { ...liveModel(modelId), ...definition } as Model<"openai-completions">;
      const tool = createLiveValueTool("live_echo");
      const userPrompt = makeUserMessage(
        "Call live_echo with value requesty. Do not answer directly.",
        Date.now() - 3,
      );
      const first = await completeSimple(
        model,
        { messages: [userPrompt], tools: [tool] },
        { apiKey: REQUESTY_API_KEY, maxTokens: 2048, reasoning: "low" },
      );
      if (first.stopReason === "error") {
        throw new Error(first.errorMessage || "Requesty first turn returned an error");
      }
      const toolCall = requireLiveToolCall(first, "Requesty live model did not call a tool: ");
      expect(toolCall.name).toBe("live_echo");
      expect(toolCall.arguments).toEqual({ value: "requesty" });

      const second = await completeSimple(
        model,
        {
          messages: [
            userPrompt,
            first,
            makeTextToolResult(toolCall.id, toolCall.name, "ok", false, Date.now() - 1),
            { role: "user", content: "Reply with exactly: ok", timestamp: Date.now() },
          ],
          tools: [tool],
        },
        { apiKey: REQUESTY_API_KEY, maxTokens: 2048, reasoning: "low" },
      );
      if (second.stopReason === "error") {
        throw new Error(second.errorMessage || "Requesty second turn returned an error");
      }
      expect(extractNonEmptyAssistantText(second.content)).toMatch(/^ok[.!]?$/i);
    },
    120_000,
  );
});
