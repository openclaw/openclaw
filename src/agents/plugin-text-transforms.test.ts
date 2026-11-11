import type { AssistantMessageEvent, Context, Model, ToolCall } from "openclaw/plugin-sdk/llm";
import { expect, it } from "vitest";
import { mergePluginTextTransforms, wrapStreamFnTextTransforms } from "./plugin-text-transforms.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { createQueuedAssistantStream } from "./test-helpers/assistant-event-stream.test-support.js";

const model = {
  api: "openai-responses",
  provider: "test",
  id: "test-model",
} as Model<"openai-responses">;

function makeAssistantMessage(content: string | ToolCall) {
  return makeAgentAssistantMessage({
    content: typeof content === "string" ? [{ type: "text", text: content }] : [content],
    stopReason: typeof content === "string" ? "stop" : "toolUse",
    provider: "test",
  });
}
function toolCall(name: string, args: ToolCall["arguments"]): ToolCall {
  return { type: "toolCall", id: name, name, arguments: args };
}

async function runTransform(
  transforms: Omit<Parameters<typeof wrapStreamFnTextTransforms>[0], "streamFn">,
  context: Context,
  sourceEvents: AssistantMessageEvent[],
) {
  let input: Context | undefined;
  const stream = await wrapStreamFnTextTransforms({
    ...transforms,
    streamFn: (_model, prepared) => {
      input = prepared;
      return createQueuedAssistantStream((push) => sourceEvents.forEach(push));
    },
  })(model, context);
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return { input, events, result: await stream.result() };
}

it.each([undefined, false])(
  "transforms transport text with system prompt option %s",
  async (transformSystemPrompt) => {
    const { input, events, result } = await runTransform(
      {
        ...mergePluginTextTransforms(
          { input: [{ from: /red basket/g, to: "paper ticket" }] },
          {
            input: [{ from: "paper ticket", to: "blue basket" }],
            output: [
              { from: /blue basket/g, to: "red basket" },
              { from: /right shelf/g, to: "left shelf" },
            ],
          },
        ),
        transformSystemPrompt,
      },
      {
        systemPrompt: "Use red basket",
        messages: [
          { role: "user", content: "Use red basket" },
          {
            role: "user",
            content: [
              { type: "text", text: "Use red basket" },
              { type: "image", url: "data:image/png;base64,abc" },
            ],
          },
        ],
      } as Context,
      [
        {
          type: "text_delta",
          contentIndex: 0,
          delta: "blue basket on the right shelf",
          partial: makeAssistantMessage("blue basket on the right shelf"),
        },
        {
          type: "done",
          reason: "stop",
          message: makeAssistantMessage("final blue basket on the right shelf"),
        },
      ],
    );

    expect(input?.systemPrompt).toBe(
      transformSystemPrompt === false ? "Use red basket" : "Use blue basket",
    );
    expect(input?.messages).toEqual([
      { role: "user", content: "Use blue basket" },
      {
        role: "user",
        content: [
          { type: "text", text: "Use blue basket" },
          { type: "image", url: "data:image/png;base64,abc" },
        ],
      },
    ]);
    expect(events[0]).toMatchObject({ type: "text_delta", delta: "red basket on the left shelf" });
    expect(result.content).toEqual([{ type: "text", text: "final red basket on the left shelf" }]);
  },
);

it("applies output replacements to structured tool-call arguments", async () => {
  const partialToolCall = toolCall("search", {
    query: "[MASKED]",
    nested: { note: "ask [MASKED] again" },
    entries: ["[MASKED]", 7],
  });
  const finalToolCall = toolCall("send_msg", { text: "[MASKED]" });
  const partial = makeAssistantMessage(partialToolCall);
  const { events, result } = await runTransform(
    { output: [{ from: /\[MASKED\]/g, to: "John" }] },
    { messages: [] },
    [
      { type: "toolcall_delta", contentIndex: 0, delta: '{"query":"[MASKED]"}', partial },
      { type: "toolcall_end", contentIndex: 0, toolCall: partialToolCall, partial },
      { type: "done", reason: "toolUse", message: makeAssistantMessage(finalToolCall) },
    ],
  );
  const deltaEvent = events.find((event) => event.type === "toolcall_delta");
  const expectedTool = {
    name: "search",
    arguments: {
      query: "John",
      nested: { note: "ask John again" },
      entries: ["John", 7],
    },
  };
  // Raw JSON deltas stay untouched; structured arguments are transformed.
  expect(deltaEvent?.delta).toBe('{"query":"[MASKED]"}');
  expect(deltaEvent?.partial?.content[0]).toMatchObject(expectedTool);

  const endEvent = events.find((event) => event.type === "toolcall_end");
  expect(endEvent?.toolCall?.name).toBe(expectedTool.name);
  expect(endEvent?.toolCall?.arguments).toEqual(expectedTool.arguments);

  expect(result.content[0]).toMatchObject({
    name: "send_msg",
    arguments: { text: "John" },
  });
});
