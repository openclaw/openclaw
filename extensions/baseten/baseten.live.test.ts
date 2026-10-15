import { detectAndLoadAgentHarnessPromptImages } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  streamSimple,
  type AssistantMessage,
  type Context,
  type Model,
  type Tool,
} from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createSolidPngBuffer } from "openclaw/plugin-sdk/test-fixtures";
import { extractNonEmptyAssistantText, isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import basetenPlugin from "./index.js";
import {
  BASETEN_BASE_URL,
  BASETEN_DEFAULT_MODEL_ID,
  BASETEN_MODEL_CATALOG,
  usesBasetenChatTemplateThinking,
} from "./models.js";

const LIVE_VALUE = process.env.BASETEN_API_KEY?.trim() ?? "";
const LIVE = isLiveTestEnabled(["BASETEN_LIVE_TEST"]) && LIVE_VALUE.length > 0;
const describeLive = LIVE ? describe : describe.skip;

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function runLiveBasetenCatalog(provider: Parameters<typeof runSingleProviderCatalog>[0]) {
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
    provider: "baseten",
    baseUrl: BASETEN_BASE_URL,
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
    throw new Error(`Baseten default model did not call the live probe: ${message.stopReason}`);
  }
  return toolCall;
}

describeLive("Baseten plugin live", () => {
  it(
    "discovers and completes through every Baseten Model API",
    async () => {
      const provider = await registerSingleProviderPlugin(basetenPlugin);
      const catalog = await runLiveBasetenCatalog(provider);
      const models = catalog.models;
      const ids = new Set(models.map((model) => model.id));
      for (const staticModel of BASETEN_MODEL_CATALOG) {
        expect(ids.has(staticModel.id), `missing live model ${staticModel.id}`).toBe(true);
      }

      console.info(`[baseten:live] discovered ${models.length} models`);
      const failures: string[] = [];
      for (const model of models) {
        try {
          const thinkingLevel = model.id === "moonshotai/Kimi-K2.6" ? "low" : "off";
          const wrappedStream = provider.wrapStreamFn?.({
            provider: "baseten",
            modelId: model.id,
            thinkingLevel,
            streamFn: streamSimple,
          } as never);
          if (!wrappedStream) {
            throw new Error("Baseten provider did not register a stream wrapper");
          }
          const context: Context = {
            messages: [
              {
                role: "user",
                content: "Say hello in one word.",
                timestamp: Date.now(),
              },
            ],
          };
          let payload: Record<string, unknown> | undefined;
          let stream = await wrappedStream(asLiveModel(model), context, {
            apiKey: LIVE_VALUE,
            maxTokens: 64,
            reasoning: thinkingLevel,
            onPayload: (value) => {
              payload = value as Record<string, unknown>;
            },
          });
          let response = await stream.result();
          if (response.stopReason === "length" && response.content.length === 0) {
            console.info(`[baseten:live] ${model.id}: retrying with 512 output tokens`);
            stream = await wrappedStream(asLiveModel(model), context, {
              apiKey: LIVE_VALUE,
              maxTokens: 512,
              reasoning: thinkingLevel,
              onPayload: (value) => {
                payload = value as Record<string, unknown>;
              },
            });
            response = await stream.result();
          }
          if (response.stopReason === "error" || response.content.length === 0) {
            throw new Error(response.errorMessage || `empty ${response.stopReason} response`);
          }
          if (usesBasetenChatTemplateThinking(model.id)) {
            expect(payload?.chat_template_args, model.id).toMatchObject({
              enable_thinking: thinkingLevel !== "off",
            });
          }
          console.info(`[baseten:live] ${model.id}: ok`);
        } catch (error) {
          failures.push(`${model.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      expect(failures).toEqual([]);
    },
    20 * 60_000,
  );

  it("runs the default model's tool call through OpenClaw's completions transport", async () => {
    const provider = await registerSingleProviderPlugin(basetenPlugin);
    const catalog = await runLiveBasetenCatalog(provider);
    const defaultModel = catalog.models.find((model) => model.id === BASETEN_DEFAULT_MODEL_ID);
    if (!defaultModel) {
      throw new Error(`Baseten live catalog did not include ${BASETEN_DEFAULT_MODEL_ID}`);
    }

    const wrappedStream = provider.wrapStreamFn?.({
      provider: "baseten",
      modelId: defaultModel.id,
      thinkingLevel: "low",
      streamFn: streamSimple,
    } as never);
    if (!wrappedStream) {
      throw new Error("Baseten provider did not register a stream wrapper");
    }
    let payload: Record<string, unknown> | undefined;
    const stream = await wrappedStream(
      asLiveModel(defaultModel),
      {
        systemPrompt: "Call the requested function exactly once.",
        messages: [
          {
            role: "user",
            content: "Call live_probe with value exactly inkling.",
            timestamp: Date.now(),
          },
        ],
        tools: [liveProbeTool()],
      },
      {
        apiKey: LIVE_VALUE,
        maxTokens: 256,
        reasoning: "low",
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
      throw new Error(response.errorMessage || "Baseten default model tool call failed");
    }
    expect(payload?.reasoning_effort).toBe("low");
    expect(payload?.max_tokens).toBe(256);
    const toolCall = requireToolCall(response);
    expect(toolCall).toMatchObject({ name: "live_probe", arguments: { value: "inkling" } });
  }, 120_000);

  it("recognizes an image through registered preparation and the default model", async () => {
    const provider = await registerSingleProviderPlugin(basetenPlugin);
    const catalog = await runLiveBasetenCatalog(provider);
    const definition = catalog.models.find((model) => model.id === BASETEN_DEFAULT_MODEL_ID);
    if (!definition) {
      throw new Error(`Baseten live catalog did not include ${BASETEN_DEFAULT_MODEL_ID}`);
    }
    const model = asLiveModel(definition);
    const bytes = createSolidPngBuffer(96, 96, { r: 0, g: 255, b: 0 });
    const prompt = "Look at the image and name its basic color. Reply with one uppercase word.";
    const prepared = await detectAndLoadAgentHarnessPromptImages({
      prompt,
      workspaceDir: process.cwd(),
      model,
      existingImages: [{ type: "image", mimeType: "image/png", data: bytes.toString("base64") }],
    });
    expect(prepared.images).toHaveLength(1);
    const wrapped = provider.wrapStreamFn?.({
      provider: "baseten",
      modelId: model.id,
      model,
      thinkingLevel: "low",
      streamFn: streamSimple,
    });
    if (!wrapped) {
      throw new Error("Baseten provider did not register its stream wrapper");
    }
    let payload: Record<string, unknown> | undefined;
    const stream = await wrapped(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }, ...prepared.images],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: LIVE_VALUE,
        maxTokens: 256,
        reasoning: "low",
        onPayload: (value) => {
          payload = value as Record<string, unknown>;
        },
      },
    );
    const response = await stream.result();
    const text = extractNonEmptyAssistantText(response.content).trim();
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage || "Baseten image recognition failed");
    }
    expect(payload?.reasoning_effort).toBe("low");
    expect(payload?.max_tokens).toBe(256);
    expect(JSON.stringify(payload?.messages ?? [])).toContain(prepared.images[0]!.data);
    expect(text).toBe("GREEN");
  }, 120_000);

  it("accepts a DeepSeek V4 replay after a cross-provider tool call", async () => {
    const provider = await registerSingleProviderPlugin(basetenPlugin);
    const catalog = await runLiveBasetenCatalog(provider);
    const deepseek = catalog.models.find(
      (model) => model.id === "deepseek-ai/DeepSeek-V4-Pro-0813",
    );
    if (!deepseek) {
      throw new Error("Baseten live catalog did not include DeepSeek V4 Pro 0813");
    }

    const toolCallId = "call_baseten_live_replay_1";
    const wrappedStream = provider.wrapStreamFn?.({
      provider: "baseten",
      modelId: deepseek.id,
      thinkingLevel: "high",
      streamFn: streamSimple,
    } as never);
    if (!wrappedStream) {
      throw new Error("Baseten provider did not register a stream wrapper");
    }

    let payload: Record<string, unknown> | undefined;
    const stream = await wrappedStream(
      asLiveModel(deepseek),
      {
        messages: [
          { role: "user", content: "Call live_probe.", timestamp: Date.now() - 3 },
          {
            role: "assistant",
            api: "openai-completions",
            provider: "openai",
            model: "gpt-5.5",
            content: [
              {
                type: "toolCall",
                id: toolCallId,
                name: "live_probe",
                arguments: { value: "replay" },
              },
            ],
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: Date.now() - 2,
          } as AssistantMessage,
          {
            role: "toolResult",
            toolCallId,
            toolName: "live_probe",
            content: [{ type: "text", text: "ok" }],
            isError: false,
            timestamp: Date.now() - 1,
          },
          { role: "user", content: "Reply with exactly ok.", timestamp: Date.now() },
        ],
        tools: [liveProbeTool()],
      },
      {
        apiKey: LIVE_VALUE,
        maxTokens: 512,
        reasoning: "high",
        onPayload: (value) => {
          payload = value as Record<string, unknown>;
        },
      },
    );
    const response = await stream.result();
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage || "DeepSeek V4 live replay failed");
    }

    const messages = payload?.messages;
    expect(payload).toMatchObject({
      model: "deepseek-ai/DeepSeek-V4-Pro-0813",
      max_tokens: 512,
      reasoning_effort: "high",
      thinking: { type: "enabled" },
    });
    expect(Array.isArray(messages)).toBe(true);
    expect((messages as Array<Record<string, unknown>>)[1]?.reasoning_content).toBe("");
    expect(extractNonEmptyAssistantText(response.content).trim()).toBe("ok");
  }, 120_000);
});
