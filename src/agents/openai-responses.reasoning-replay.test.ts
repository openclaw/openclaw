import "../test-utils/prepare-compiled-subprocesses.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { stream } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { makeTextToolResult } from "../../test/helpers/text-tool-result.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";

const model = makeProviderModelFixture<"openai-responses">({
  id: "gpt-5.4",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  contextWindow: 128_000,
  maxTokens: 4096,
});
const user = (content: string) => ({ role: "user" as const, content, timestamp: 0 });
const reasoning = (id = "rs_test") => ({
  type: "thinking" as const,
  thinking: "internal",
  thinkingSignature: JSON.stringify({ type: "reasoning", id, summary: [] }),
});
const text = (value: string, signature: Record<string, unknown>) => ({
  type: "text" as const,
  text: value,
  textSignature: JSON.stringify({ v: 1, ...signature }),
});
const toolCall = (id: string) => ({ type: "toolCall" as const, id, name: "noop", arguments: {} });
const assistantItems = (input: Record<string, unknown>[]) =>
  input.filter((item) => item.type === "message" && item.role === "assistant");

async function replay(content: AssistantMessage["content"], storeless = false) {
  const calls = content.filter((part) => part.type === "toolCall");
  const assistant: AssistantMessage = {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    usage: createZeroUsageFixture(),
    timestamp: 0,
    stopReason: calls.length ? "toolUse" : "stop",
  };
  let payload: Record<string, unknown> | undefined;
  const result = await stream(
    storeless
      ? {
          ...model,
          provider: "custom-openai-responses",
          baseUrl: "https://custom.example.invalid/v1",
          compat: { supportsStore: false } as never,
        }
      : model,
    {
      systemPrompt: "system",
      messages: [
        user("Hi"),
        assistant,
        ...calls.map((call) => makeTextToolResult(call.id, "noop", "ok", false, 0)),
        user("Ok"),
      ],
      ...(calls.length
        ? {
            tools: [
              {
                name: "noop",
                description: "no-op",
                parameters: Type.Object({}, { additionalProperties: false }),
              },
            ],
          }
        : {}),
    },
    {
      apiKey: "test",
      ...(storeless ? {} : { replayResponsesItemIds: true }),
      onPayload: (value: unknown) => {
        if (isRecord(value)) {
          payload = value;
        }
        throw new Error("stop after payload capture");
      },
    } as never,
  ).result();
  if (!payload) {
    throw new Error(
      `Provider payload callback was not invoked; stream ended with ${result.stopReason}: ${result.errorMessage ?? "no error"}`,
    );
  }
  return (Array.isArray(payload.input) ? payload.input : []).filter(isRecord);
}

it("omits storeless Responses item ids while preserving paired tool call ids", async () => {
  const input = await replay(
    [
      reasoning("rs_storeless"),
      text("Checking.", { id: "msg_storeless", phase: "final_answer" }),
      toolCall("call_storeless|fc_storeless"),
    ],
    true,
  );
  expect(input.map((item) => item.type)).toEqual(
    expect.arrayContaining(["message", "function_call", "function_call_output"]),
  );
  expect(
    input.filter(
      (item) =>
        ["reasoning", "message", "function_call"].includes(String(item.type)) &&
        typeof item.id === "string",
    ),
  ).toEqual([]);
  const call = input.find((item) => item.type === "function_call");
  expect(call?.call_id).toBeTruthy();
  expect(input.find((item) => item.type === "function_call_output")?.call_id).toBe(call?.call_id);
});

it("replays reasoning before tool-call-only turns and preserves both call identities", async () => {
  const input = await replay([reasoning(), toolCall("call_123|fc_123")]);
  const types = input.map((item) => item.type);
  expect(types).toContain("reasoning");
  expect(types).toContain("function_call");
  expect(types.indexOf("reasoning")).toBeLessThan(types.indexOf("function_call"));
  expect(input.find((item) => item.type === "function_call")).toMatchObject({
    call_id: "call_123",
    id: "fc_123",
  });
});

it("replays assistant message id and commentary phase when paired with reasoning", async () => {
  const input = await replay([
    reasoning(),
    text("hello", { id: "msg_commentary", phase: "commentary" }),
  ]);
  expect(assistantItems(input).find((item) => item.id === "msg_commentary")?.phase).toBe(
    "commentary",
  );
});

it("assigns unique synthetic ids and preserves phases for id-less text signatures (#88019)", async () => {
  const messages = assistantItems(
    await replay([
      text("commentary", { phase: "commentary" }),
      text("final", { phase: "final_answer" }),
    ]),
  );
  const ids = messages.map((item) => item.id);
  expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  expect(new Set(ids).size).toBe(2);
  expect(messages.map((item) => item.phase)).toEqual(["commentary", "final_answer"]);
});
