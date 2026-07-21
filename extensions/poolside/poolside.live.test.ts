import {
  streamSimple,
  type AssistantMessage,
  type Context,
  type Model,
  type Tool,
} from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import poolsidePlugin from "./index.js";
import { POOLSIDE_BASE_URL, POOLSIDE_DEFAULT_MODEL_ID, POOLSIDE_MODEL_CATALOG } from "./models.js";
import { POOLSIDE_DEFAULT_TEMPERATURE } from "./stream.js";

const LIVE_VALUE = process.env.POOLSIDE_API_KEY?.trim() ?? "";
const LIVE = isLiveTestEnabled(["POOLSIDE_LIVE_TEST"]) && LIVE_VALUE.length > 0;
const describeLive = LIVE ? describe : describe.skip;

function asLiveModel(model: ModelDefinitionConfig) {
  return {
    ...model,
    provider: "poolside",
    baseUrl: POOLSIDE_BASE_URL,
    api: "openai-completions",
  } as Model<"openai-completions">;
}

function liveProbeTool(): Tool {
  return {
    name: "live_probe",
    description: "Return the supplied value.",
    parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
  };
}

function requireToolCall(message: AssistantMessage) {
  const toolCall = message.content.find((block) => block.type === "toolCall");
  if (toolCall?.type !== "toolCall") {
    throw new Error(`Laguna did not call the live probe: ${message.stopReason}`);
  }
  return toolCall;
}

describeLive("Poolside plugin live", () => {
  it(
    "completes through every bundled Laguna model with the temperature-only contract",
    async () => {
      const provider = await registerSingleProviderPlugin(poolsidePlugin);
      const catalog = await runSingleProviderCatalog(provider);
      const models = catalog.models;
      const ids = new Set(models.map((model) => model.id));
      for (const staticModel of POOLSIDE_MODEL_CATALOG) {
        expect(ids.has(staticModel.id), `missing model ${staticModel.id}`).toBe(true);
      }

      console.info(`[poolside:live] exercising ${models.length} models`);
      const failures: string[] = [];
      for (const model of models) {
        try {
          const wrappedStream = provider.wrapStreamFn?.({
            provider: "poolside",
            modelId: model.id,
            streamFn: streamSimple,
          } as never);
          if (!wrappedStream) {
            throw new Error("Poolside provider did not register a stream wrapper");
          }
          const context: Context = {
            messages: [{ role: "user", content: "Say hello in one word.", timestamp: Date.now() }],
          };
          let payload: Record<string, unknown> | undefined;
          const stream = await wrappedStream(asLiveModel(model), context, {
            apiKey: LIVE_VALUE,
            maxTokens: 512,
            onPayload: (value) => {
              payload = value as Record<string, unknown>;
            },
          });
          const response = await stream.result();
          if (response.stopReason === "error" || response.content.length === 0) {
            throw new Error(response.errorMessage || `empty ${response.stopReason} response`);
          }
          // Temperature-only contract: default temperature is applied and no
          // unsupported sampling field reaches the wire. The wire model id is
          // restored to the poolside/-prefixed form the endpoint expects.
          expect(payload?.temperature, model.id).toBe(POOLSIDE_DEFAULT_TEMPERATURE);
          expect(payload?.top_p, model.id).toBeUndefined();
          expect(payload?.reasoning_effort, model.id).toBeUndefined();
          expect(payload?.model, model.id).toBe(`poolside/${model.id}`);
          console.info(`[poolside:live] ${model.id}: ok`);
        } catch (error) {
          failures.push(`${model.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      expect(failures).toEqual([]);
    },
    20 * 60_000,
  );

  it("runs a Laguna tool call through OpenClaw's completions transport", async () => {
    const provider = await registerSingleProviderPlugin(poolsidePlugin);
    const catalog = await runSingleProviderCatalog(provider);
    const laguna = catalog.models.find((model) => model.id === POOLSIDE_DEFAULT_MODEL_ID);
    if (!laguna) {
      throw new Error("Poolside catalog did not include the default Laguna model");
    }

    const wrappedStream = provider.wrapStreamFn?.({
      provider: "poolside",
      modelId: laguna.id,
      streamFn: streamSimple,
    } as never);
    if (!wrappedStream) {
      throw new Error("Poolside provider did not register a stream wrapper");
    }
    let payload: Record<string, unknown> | undefined;
    const stream = await wrappedStream(
      asLiveModel(laguna),
      {
        systemPrompt: "Call the requested function exactly once.",
        messages: [
          {
            role: "user",
            content: "Call live_probe with value exactly laguna.",
            timestamp: Date.now(),
          },
        ],
        tools: [liveProbeTool()],
      },
      {
        apiKey: LIVE_VALUE,
        maxTokens: 512,
        onPayload: (value) => {
          payload = {
            ...(value as Record<string, unknown>),
            tool_choice: { type: "function", function: { name: "live_probe" } },
          };
          return payload;
        },
      },
    );
    const response = await stream.result();
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage || "Laguna live tool call failed");
    }
    expect(payload?.temperature).toBe(POOLSIDE_DEFAULT_TEMPERATURE);
    const toolCall = requireToolCall(response);
    expect(toolCall).toMatchObject({ name: "live_probe", arguments: { value: "laguna" } });
  }, 120_000);
});
