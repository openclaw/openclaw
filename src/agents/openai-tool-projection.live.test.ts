import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions.js";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import type { Context, Model } from "../llm/types.js";
import { isLiveTestEnabled } from "./live-test-helpers.js";
import {
  buildOpenAICompletionsParams,
  buildOpenAIResponsesParams,
} from "./openai-transport-stream.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const LIVE = isLiveTestEnabled(["OPENAI_LIVE_TEST"]) && Boolean(OPENAI_KEY);
const describeLive = LIVE ? describe : describe.skip;

const probeTools = [
  {
    name: "unreadable_probe",
    description: "Unreadable probe.",
    parameters: {
      type: "object",
      get properties(): never {
        throw new Error("live unreadable nested schema getter");
      },
    },
  },
  {
    name: "live_probe",
    description: "Return the requested probe value.",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
];

const context = {
  systemPrompt: "Call the requested function exactly once.",
  messages: [
    {
      role: "user",
      content: "Call live_probe with value exactly OPENAI_PROJECTION_OK.",
      timestamp: 1,
    },
  ],
  tools: probeTools,
} satisfies Context;

describeLive("OpenAI tool projection live", () => {
  const modelId = process.env.OPENCLAW_LIVE_OPENAI_TOOL_MODEL || "gpt-5.5";
  const client = new OpenAI({ apiKey: OPENAI_KEY });

  it("calls a healthy Responses function after quarantining an unreadable sibling", async () => {
    const model = {
      id: modelId,
      name: modelId,
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 256,
    } satisfies Model<"openai-responses">;
    const params = buildOpenAIResponsesParams(model, context, {
      maxTokens: 128,
      reasoning: "low",
      toolChoice: { type: "function", name: "live_probe" },
    });

    const response = await client.responses.create({
      ...params,
      stream: false,
    } as unknown as ResponseCreateParamsNonStreaming);
    const toolCall = response.output.find((item) => item.type === "function_call");

    expect(toolCall).toMatchObject({
      type: "function_call",
      name: "live_probe",
    });
    expect(JSON.parse(toolCall?.arguments ?? "{}")).toEqual({
      value: "OPENAI_PROJECTION_OK",
    });
  }, 45_000);

  it("calls a healthy Chat Completions function after quarantining an unreadable sibling", async () => {
    const model = {
      id: modelId,
      name: modelId,
      api: "openai-completions",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 256,
    } satisfies Model<"openai-completions">;
    const params = buildOpenAICompletionsParams(model, context, {
      maxTokens: 128,
      toolChoice: {
        type: "allowed_tools",
        allowed_tools: {
          mode: "required",
          tools: [
            { type: "function", function: { name: "unreadable_probe" } },
            { type: "function", function: { name: "live_probe" } },
          ],
        },
      },
    });
    const { stream_options: _streamOptions, ...nonStreamingParams } = params;

    const response = await client.chat.completions.create({
      ...nonStreamingParams,
      stream: false,
    } as unknown as ChatCompletionCreateParamsNonStreaming);
    const toolCall = response.choices[0]?.message.tool_calls?.[0];

    if (!toolCall || toolCall.type !== "function") {
      throw new Error("OpenAI did not return the expected function tool call");
    }
    expect(toolCall).toMatchObject({
      type: "function",
      function: { name: "live_probe" },
    });
    expect(JSON.parse(toolCall.function.arguments)).toEqual({
      value: "OPENAI_PROJECTION_OK",
    });
  }, 45_000);
});
