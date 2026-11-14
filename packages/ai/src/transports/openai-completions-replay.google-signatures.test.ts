import { expect, it } from "vitest";
import type { Model } from "../types.js";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import { streamFixture } from "./openai-completions-suite.test-support.js";
import {
  createAssistantOutput,
  expectRecordFields,
  getAssistantMessage,
  makeCompletionsChunk,
  makeCompletionsModel,
} from "./openai-completions.test-support.js";

function replayedTool(
  model: Model<"openai-completions">,
  options: {
    sourceApi?: string;
    thoughtSignature?: string;
  } = {},
) {
  const assistant = {
    ...createAssistantOutput(model),
    api: options.sourceApi ?? model.api,
    stopReason: "toolUse",
    timestamp: 1,
    content: [
      {
        type: "toolCall",
        id: "call_abc",
        name: "echo_value",
        arguments: { value: "repro" },
        ...(options.thoughtSignature ? { thoughtSignature: options.thoughtSignature } : {}),
      },
    ],
  };
  const context = {
    messages: [
      { role: "user", content: "echo" },
      assistant,
      {
        role: "toolResult",
        toolCallId: "call_abc",
        toolName: "echo_value",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ],
    tools: [{ name: "echo_value", description: "Echo", parameters: { type: "object" } }],
  };
  const replay = getAssistantMessage(
    buildOpenAICompletionsParams(model, context as never, undefined),
  ) as { tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> };
  return replay.tool_calls?.[0]?.extra_content;
}

const signature = "SIG-OPAQUE-ABC==";
const skip = "skip_thought_signature_validator";
const otherApi = "google-generative-ai";
const truncated =
  "CmcBjz1rX55U6JcpC2oZVTk40Kx6nVK8LKzbl61rOFztcvSdL7pdIvBEDyJLRqWrPVpdD+rj3GsJ3f9PG6b2Ry2UnK38+dInfGIlJbXHt++EC";
const geminiModel = makeCompletionsModel({
  id: "gemini-3-flash-preview",
  provider: "google",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
});

it.each([false, true])("captures streamed signatures (top-level=%s)", async (topLevel) => {
  const model = topLevel
    ? makeCompletionsModel({
        id: "gemini-3-6-flash",
        provider: "venice",
        baseUrl: "https://api.venice.ai/api/v1",
      })
    : geminiModel;
  const streamedSignature = topLevel ? "SIG-VENICE-OPAQUE-ABC==" : signature;
  const { output, run } = streamFixture(model);
  await run([
    makeCompletionsChunk({
      tool_calls: [
        {
          index: 0,
          id: "call_abc",
          type: "function",
          function: { name: "echo_value", arguments: topLevel ? '{"value":"repro"}' : "" },
          ...(topLevel
            ? { thought_signature: streamedSignature }
            : { extra_content: { google: { thought_signature: streamedSignature } } }),
        },
      ],
    }),
    makeCompletionsChunk(
      topLevel ? {} : { tool_calls: [{ index: 0, function: { arguments: '{"value":"repro"}' } }] },
      "tool_calls",
    ),
  ]);
  expectRecordFields(output.content[0], {
    type: "toolCall",
    id: "call_abc",
    name: "echo_value",
    arguments: { value: "repro" },
    thoughtSignature: streamedSignature,
  });
});

it.each([
  ["same route", geminiModel.id, undefined, signature, signature],
  ["different API", geminiModel.id, otherApi, signature, skip],
  ["truncated signature", "gemini-2.5-pro", undefined, truncated, undefined],
  ["untrusted cross-route", "gemini-2.5-pro", otherApi, signature, undefined],
] as const)("replays %s", (_name, id, sourceApi, thoughtSignature, expected) => {
  const extra = replayedTool({ ...geminiModel, id }, { sourceApi, thoughtSignature });
  expect(extra).toEqual(expected ? { google: { thought_signature: expected } } : undefined);
});

it.each(["gemini-3-flash-preview", "gemini-3.8-flash", "gemini-4-argon"])(
  "uses the skip-validator signature for unsigned %s replay",
  (id) => {
    const target = { ...geminiModel, id };
    const extra = replayedTool(target);
    expect(extra?.google?.thought_signature).toBe(skip);
  },
);
