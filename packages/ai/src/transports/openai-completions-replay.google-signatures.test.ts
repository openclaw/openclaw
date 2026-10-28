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
  ) as { tool_calls?: Array<{ extra_content?: unknown; provider_specific_fields?: unknown }> };
  const { extra_content, provider_specific_fields } = replay.tool_calls?.[0] ?? {};
  return JSON.parse(JSON.stringify({ extra_content, provider_specific_fields })) as unknown;
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

it.each([false, "thought_signature", "provider_specific_fields"] as const)(
  "captures streamed signatures (top-level=%s)",
  async (topLevel) => {
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
            ...(topLevel === "thought_signature"
              ? { thought_signature: streamedSignature }
              : topLevel
                ? { provider_specific_fields: { thought_signature: streamedSignature } }
                : { extra_content: { google: { thought_signature: streamedSignature } } }),
          },
        ],
      }),
      makeCompletionsChunk(
        topLevel
          ? {}
          : { tool_calls: [{ index: 0, function: { arguments: '{"value":"repro"}' } }] },
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
  },
);

const google = (sig: string) => ({ extra_content: { google: { thought_signature: sig } } });
const litellmField = (sig: string) => ({ provider_specific_fields: { thought_signature: sig } });
const gemini = (id: string) => ({ ...geminiModel, id });
const litellm = makeCompletionsModel({ id: "gemini-3.8-flash-high", provider: "litellm" });
it.each([
  ["same route", geminiModel, undefined, signature, google(signature)],
  ["different API", geminiModel, otherApi, signature, google(skip)],
  ["truncated signature", gemini("gemini-2.5-pro"), undefined, truncated, {}],
  ["untrusted cross-route", gemini("gemini-2.5-pro"), otherApi, signature, {}],
  ["LiteLLM same route", litellm, undefined, signature, litellmField(signature)],
  ["LiteLLM cross-route", litellm, otherApi, signature, {}],
  ["LiteLLM encrypted reasoning detail", litellm, undefined, '{"type":"reasoning.encrypted"}', {}],
  ["unsigned gemini-3-flash-preview", geminiModel, undefined, undefined, google(skip)],
  ["unsigned gemini-3.8-flash", gemini("gemini-3.8-flash"), undefined, undefined, google(skip)],
  ["unsigned gemini-4-argon", gemini("gemini-4-argon"), undefined, undefined, google(skip)],
] as const)("replays %s", (_name, model, sourceApi, thoughtSignature, expected) => {
  expect(replayedTool(model, { sourceApi, thoughtSignature })).toEqual(expected);
});
