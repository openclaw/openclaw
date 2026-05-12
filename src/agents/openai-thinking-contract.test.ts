import { Agent, type StreamFn } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
} from "./pi-ai-contract.js";

type ResponsesModel = Model<"openai-responses"> | Model<"openai-codex-responses">;

const openaiModel = {
  api: "openai-responses",
  provider: "openai",
  id: "gpt-5.5",
  input: ["text"],
  reasoning: true,
} as Model<"openai-responses">;

const codexModel = {
  api: "openai-codex-responses",
  provider: "openai-codex",
  id: "gpt-5.5",
  input: ["text"],
  reasoning: true,
  baseUrl: "https://chatgpt.com/backend-api",
} as Model<"openai-codex-responses">;

describe("OpenAI thinking contract", () => {
  it.each([
    { model: openaiModel, expectedReasoning: "high" },
    { model: codexModel, expectedReasoning: "high" },
  ])(
    "forwards enabled session thinkingLevel to pi-ai options for $model.provider/$model.id",
    async ({ model, expectedReasoning }) => {
      const capturedOptions: SimpleStreamOptions[] = [];
      const agent = new Agent({
        initialState: {
          model,
          thinkingLevel: "high",
        },
        streamFn: createCapturingStreamFn(model, capturedOptions),
      });

      await agent.prompt("hello");

      expect(capturedOptions.map(({ reasoning }) => reasoning)).toStrictEqual([expectedReasoning]);
    },
  );

  it.each([openaiModel, codexModel])(
    "does not forward reasoning when session thinkingLevel is off for $provider/$id",
    async (model) => {
      const capturedOptions: SimpleStreamOptions[] = [];
      const agent = new Agent({
        initialState: {
          model,
          thinkingLevel: "off",
        },
        streamFn: createCapturingStreamFn(model, capturedOptions),
      });

      await agent.prompt("hello");

      expect(capturedOptions.map(({ reasoning }) => reasoning)).toStrictEqual([undefined]);
    },
  );
});

function createCapturingStreamFn(
  model: ResponsesModel,
  capturedOptions: SimpleStreamOptions[],
): StreamFn {
  return (_model, _context, options) => {
    capturedOptions.push({ ...options });
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({
        type: "done",
        reason: "stop",
        message: createAssistantMessage(model),
      });
    });
    return stream;
  };
}

function createAssistantMessage(model: ResponsesModel): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}
