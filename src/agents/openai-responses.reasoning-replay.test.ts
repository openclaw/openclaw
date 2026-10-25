import "../test-utils/prepare-compiled-subprocesses.js";
import type { AssistantMessage, Model, ToolResultMessage } from "openclaw/plugin-sdk/llm";
import { stream } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";

function buildModel(): Model<"openai-responses"> {
  return makeProviderModelFixture<"openai-responses">({
    id: "gpt-5.4",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    contextWindow: 128_000,
    maxTokens: 4096,
  });
}

const inputItems = (input: unknown[]): Record<string, unknown>[] =>
  input.filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
  );
const assistantItems = (input: Record<string, unknown>[]) =>
  input.filter((item) => item.type === "message" && item.role === "assistant");

const ZERO_USAGE = createZeroUsageFixture();

function buildReasoningPart(id = "rs_test") {
  return {
    type: "thinking" as const,
    thinking: "internal",
    thinkingSignature: JSON.stringify({ type: "reasoning", id, summary: [] }),
  };
}

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: ZERO_USAGE,
    stopReason,
    timestamp: Date.now(),
    content,
  };
}

async function captureOpenAIResponsesPayload(params: {
  messages: Array<
    AssistantMessage | ToolResultMessage | { role: "user"; content: string; timestamp: number }
  >;
  tools?: Array<{
    name: string;
    description: string;
    parameters: ReturnType<typeof Type.Object>;
  }>;
  usePolicyReplayDefault?: boolean;
  model?: Model<"openai-responses">;
}) {
  let payload: Record<string, unknown> | undefined;

  const responseStream = stream(
    params.model ?? buildModel(),
    {
      systemPrompt: "system",
      messages: params.messages,
      ...(params.tools ? { tools: params.tools } : {}),
    },
    {
      apiKey: "test",
      ...(params.usePolicyReplayDefault ? {} : { replayResponsesItemIds: true }),
      onPayload: (nextPayload: unknown) => {
        payload = nextPayload as Record<string, unknown>;
        throw new Error("stop after payload capture");
      },
    } as never,
  );

  const result = await responseStream.result();
  if (!payload) {
    throw new Error(
      `Provider payload callback was not invoked; stream ended with ${result.stopReason}: ${result.errorMessage ?? "no error"}`,
    );
  }
  const input = inputItems(Array.isArray(payload.input) ? payload.input : []);
  return {
    input,
    types: input.map((item) => item.type),
  };
}
const user = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });
const text = (value: string, signature: Record<string, unknown>) => ({
  type: "text" as const,
  text: value,
  textSignature: JSON.stringify({ v: 1, ...signature }),
});
const toolCall = (id: string) => ({ type: "toolCall" as const, id, name: "noop", arguments: {} });
function captureText(content: AssistantMessage["content"]) {
  return captureOpenAIResponsesPayload({ messages: [user("Hi"), assistant(content), user("Ok")] });
}

function captureToolReplay(
  reply: AssistantMessage,
  callId: string,
  options: Omit<Parameters<typeof captureOpenAIResponsesPayload>[0], "messages" | "tools"> = {},
) {
  const toolResult: ToolResultMessage = {
    role: "toolResult",
    toolCallId: callId,
    toolName: "noop",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: Date.now(),
  };
  return captureOpenAIResponsesPayload({
    ...options,
    messages: [user("Call noop."), reply, toolResult, user("Now reply with ok.")],
    tools: [
      {
        name: "noop",
        description: "no-op",
        parameters: Type.Object({}, { additionalProperties: false }),
      },
    ],
  });
}

describe("openai-responses reasoning replay", () => {
  it("omits Responses item ids for storeless custom providers while preserving tool call ids", async () => {
    const assistantToolOnly = assistant(
      [
        buildReasoningPart("rs_storeless"),
        text("Checking.", { id: "msg_storeless", phase: "final_answer" }),
        toolCall("call_storeless|fc_storeless"),
      ],
      "toolUse",
    );

    const { input, types } = await captureToolReplay(
      assistantToolOnly,
      "call_storeless|fc_storeless",
      {
        model: {
          ...buildModel(),
          provider: "custom-openai-responses",
          baseUrl: "https://custom.example.invalid/v1",
          compat: { supportsStore: false } as never,
        },
        usePolicyReplayDefault: true,
      },
    );

    expect(types).toEqual(
      expect.arrayContaining(["message", "function_call", "function_call_output"]),
    );

    const replayedItemIds = input.filter(
      (item) =>
        ["reasoning", "message", "function_call"].includes(String(item.type)) &&
        typeof item.id === "string",
    );
    expect(replayedItemIds).toEqual([]);

    const functionCall = input.find((item) => item.type === "function_call");
    const functionCallOutput = input.find((item) => item.type === "function_call_output");
    expect(functionCall?.call_id).toBeTruthy();
    expect(functionCallOutput?.call_id).toBe(functionCall?.call_id);
  });

  it("replays reasoning for tool-call-only turns (OpenAI requires it)", async () => {
    const assistantToolOnly = assistant(
      [buildReasoningPart(), toolCall("call_123|fc_123")],
      "toolUse",
    );

    const { input, types } = await captureToolReplay(assistantToolOnly, "call_123|fc_123");

    expect(types).toContain("reasoning");
    expect(types).toContain("function_call");
    expect(types.indexOf("reasoning")).toBeLessThan(types.indexOf("function_call"));

    expect(input.find((item) => item.type === "function_call")).toMatchObject({
      call_id: "call_123",
      id: "fc_123",
    });
  });

  it("replays assistant message id and commentary phase when paired with reasoning", async () => {
    const { input, types } = await captureText([
      buildReasoningPart(),
      text("hello", { id: "msg_commentary", phase: "commentary" }),
    ]);
    expect(types).toContain("message");
    expect(assistantItems(input).find((item) => item.id === "msg_commentary")?.phase).toBe(
      "commentary",
    );
  });

  it("replays a synthetic id while preserving phase for id-less text signatures", async () => {
    // After a reasoning drop the sanitizer keeps the phase but removes the msg_*
    // id. The conversion must then emit a unique synthetic id per text block AND
    // retain the phase metadata (issue #88019 review follow-up).
    const { input } = await captureText([
      text("commentary", { phase: "commentary" }),
      text("final", { phase: "final_answer" }),
    ]);
    const messages = assistantItems(input);
    const ids = messages.map((item) => item.id);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2);
    expect(messages.map((item) => item.phase)).toEqual(["commentary", "final_answer"]);
  });
});
