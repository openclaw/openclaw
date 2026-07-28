// Telnyx live tests exercise the real inference API (OPENCLAW_LIVE_TEST gated).
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
import telnyxPlugin from "./index.js";
import { TELNYX_BASE_URL, TELNYX_DEFAULT_MODEL_ID, TELNYX_MODEL_CATALOG } from "./models.js";

const LIVE_VALUE = process.env.TELNYX_API_KEY?.trim() ?? "";
const LIVE = isLiveTestEnabled(["TELNYX_LIVE_TEST"]) && LIVE_VALUE.length > 0;
const describeLive = LIVE ? describe : describe.skip;

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function runLiveTelnyxCatalog(provider: Parameters<typeof runSingleProviderCatalog>[0]) {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldVitest = process.env.VITEST;
  delete process.env.NODE_ENV;
  delete process.env.VITEST;
  try {
    return await runSingleProviderCatalog(provider, {
      resolveProviderAuth: () => ({
        apiKey: LIVE_VALUE,
        discoveryApiKey: LIVE_VALUE,
        mode: "api_key",
        source: "env",
      }),
    });
  } finally {
    restoreEnvVar("NODE_ENV", oldNodeEnv);
    restoreEnvVar("VITEST", oldVitest);
  }
}

function asLiveModel(model: ModelDefinitionConfig) {
  return {
    ...model,
    provider: "telnyx",
    baseUrl: TELNYX_BASE_URL,
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
    throw new Error(`model did not call the live probe: ${message.stopReason}`);
  }
  return toolCall;
}

describeLive("Telnyx plugin live", () => {
  it(
    "discovers the live catalog and completes through the default model",
    async () => {
      const provider = await registerSingleProviderPlugin(telnyxPlugin);
      const catalog = await runLiveTelnyxCatalog(provider);
      const models = catalog.models;
      const ids = new Set(models.map((model) => model.id));
      for (const staticModel of TELNYX_MODEL_CATALOG) {
        expect(ids.has(staticModel.id), `missing live model ${staticModel.id}`).toBe(true);
      }
      console.info(`[telnyx:live] discovered ${models.length} models`);

      const defaultModel = models.find((model) => model.id === TELNYX_DEFAULT_MODEL_ID);
      if (!defaultModel) {
        throw new Error("Telnyx live catalog did not include the default model");
      }
      const context: Context = {
        messages: [{ role: "user", content: "Say hello in one word.", timestamp: Date.now() }],
      };
      const stream = streamSimple(asLiveModel(defaultModel), context, {
        apiKey: LIVE_VALUE,
        maxTokens: 512,
        reasoning: "off",
      });
      const response = await stream.result();
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "live completion failed");
      }
      expect(response.content.length).toBeGreaterThan(0);
    },
    5 * 60_000,
  );

  it("runs a tool call through OpenClaw's completions transport", async () => {
    const provider = await registerSingleProviderPlugin(telnyxPlugin);
    const catalog = await runLiveTelnyxCatalog(provider);
    const defaultModel = catalog.models.find((model) => model.id === TELNYX_DEFAULT_MODEL_ID);
    if (!defaultModel) {
      throw new Error("Telnyx live catalog did not include the default model");
    }

    const stream = streamSimple(
      asLiveModel(defaultModel),
      {
        systemPrompt: "Call the requested function exactly once.",
        messages: [
          {
            role: "user",
            content: "Call live_probe with value exactly telnyx.",
            timestamp: Date.now(),
          },
        ],
        tools: [liveProbeTool()],
      },
      {
        apiKey: LIVE_VALUE,
        maxTokens: 1024,
        reasoning: "off",
      },
    );
    const response = await stream.result();
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage || "live tool call failed");
    }
    const toolCall = requireToolCall(response);
    expect(toolCall.name).toBe("live_probe");
    expect(toolCall.arguments).toMatchObject({ value: "telnyx" });
  }, 120_000);
});
