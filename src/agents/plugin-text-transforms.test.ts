import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ToolCall,
} from "openclaw/plugin-sdk/llm";
import { expect, it } from "vitest";
import {
  applyPluginTextReplacements,
  mergePluginTextTransforms,
  wrapStreamFnTextTransforms,
} from "./plugin-text-transforms.js";
import { createQueuedAssistantStream } from "./test-helpers/assistant-event-stream.test-support.js";
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";

const model = {
  api: "openai-responses",
  provider: "test",
  id: "test-model",
} as Model<"openai-responses">;

function makeAssistantMessage(content: string | ToolCall): AssistantMessage {
  return {
    role: "assistant",
    content: typeof content === "string" ? [{ type: "text", text: content }] : [content],
    stopReason: typeof content === "string" ? "stop" : "toolUse",
    api: "openai-responses",
    provider: "test",
    model: "test-model",
    usage: { ...createZeroUsageFixture(), input: 1, output: 1, totalTokens: 2 },
    timestamp: 0,
  };
}

function transformFixture(
  transforms: Omit<Parameters<typeof wrapStreamFnTextTransforms>[0], "streamFn">,
  ...events: AssistantMessageEvent[]
) {
  let input: Context | undefined;
  const wrapped = wrapStreamFnTextTransforms({
    ...transforms,
    streamFn: (_model, context) => {
      input = context;
      return createQueuedAssistantStream((push) => {
        for (const event of events) {
          push(event);
        }
      });
    },
  });
  return {
    getInput: () => input,
    run: (context: Context) => Promise.resolve(wrapped(model, context)),
  };
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>) {
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

it("merges registered transform groups in order", () => {
  const first = { from: /red basket/g, to: "blue basket" };
  const output = [{ from: /blue basket/g, to: "red basket" }];
  const rest = [
    { from: /paper ticket/g, to: "digital ticket" },
    { from: "digital ticket", to: "counter receipt" },
  ];
  const expected = structuredClone({ input: [first, ...rest], output });
  const merged = mergePluginTextTransforms({ input: [first] }, { output }, { input: rest });
  expect(merged).toStrictEqual(expected);
  expect(applyPluginTextReplacements("red basket paper ticket", merged?.input)).toBe(
    "blue basket counter receipt",
  );
});

it.each([undefined, false])(
  "transforms transport text with system prompt option %s",
  async (transformSystemPrompt) => {
    const fixture = transformFixture(
      {
        input: [{ from: /red basket/g, to: "blue basket" }],
        output: [
          { from: /blue basket/g, to: "red basket" },
          { from: /right shelf/g, to: "left shelf" },
        ],
        transformSystemPrompt,
      },
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
    );
    const stream = await fixture.run({
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
    } as Context);
    const events = await collectEvents(stream);
    const result = await stream.result();

    expect(fixture.getInput()?.systemPrompt).toBe(
      transformSystemPrompt === false ? "Use red basket" : "Use blue basket",
    );
    expect(fixture.getInput()?.messages).toEqual([
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
  const partialToolCall: ToolCall = {
    type: "toolCall",
    id: "call-1",
    name: "search",
    arguments: {
      query: "[MASKED]",
      nested: { note: "ask [MASKED] again" },
      entries: ["[MASKED]", 7],
    },
  };
  const finalToolCall: ToolCall = {
    type: "toolCall",
    id: "call-2",
    name: "send_msg",
    arguments: { text: "[MASKED]" },
  };
  const partial = makeAssistantMessage(partialToolCall);
  const fixture = transformFixture(
    { output: [{ from: /\[MASKED\]/g, to: "John" }] },
    { type: "toolcall_delta", contentIndex: 0, delta: '{"query":"[MASKED]"}', partial },
    { type: "toolcall_end", contentIndex: 0, toolCall: partialToolCall, partial },
    { type: "done", reason: "toolUse", message: makeAssistantMessage(finalToolCall) },
  );
  const stream = await fixture.run({ messages: [] });
  const events = await collectEvents(stream);
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

  const result = await stream.result();
  expect(result.content[0]).toMatchObject({
    name: "send_msg",
    arguments: { text: "John" },
  });
});
