import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type ToolCall,
} from "openclaw/plugin-sdk/llm";
import { expect, it } from "vitest";
import {
  applyPluginTextReplacements,
  mergePluginTextTransforms,
  wrapStreamFnTextTransforms,
} from "./plugin-text-transforms.js";
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
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        for (const event of events) {
          stream.push(event);
        }
        stream.end();
      });
      return stream;
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
  const merged = mergePluginTextTransforms(
    { input: [{ from: /red basket/g, to: "blue basket" }] },
    { output: [{ from: /blue basket/g, to: "red basket" }] },
    { input: [{ from: /paper ticket/g, to: "digital ticket" }] },
  );

  expect(merged).toStrictEqual({
    input: [
      { from: /red basket/g, to: "blue basket" },
      { from: /paper ticket/g, to: "digital ticket" },
    ],
    output: [{ from: /blue basket/g, to: "red basket" }],
  });
  expect(applyPluginTextReplacements("red basket paper ticket", merged?.input)).toBe(
    "blue basket digital ticket",
  );
});

it("applies ordered string and regexp replacements", () => {
  expect(
    applyPluginTextReplacements("paper ticket on the left shelf", [
      { from: /paper ticket/g, to: "digital ticket" },
      { from: /left shelf/g, to: "right shelf" },
      { from: "digital ticket", to: "counter receipt" },
    ]),
  ).toBe("counter receipt on the right shelf");
});

it("rewrites system prompt and message text content before transport", async () => {
  const fixture = transformFixture({
    input: [
      { from: /orchid mailbox/g, to: "pine mailbox" },
      { from: /red basket/g, to: "blue basket" },
    ],
  });
  await fixture.run({
    systemPrompt: "Use orchid mailbox inside north tower",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Please use the red basket" },
          { type: "image", url: "data:image/png;base64,abc" },
        ],
      },
    ],
  } as Context);

  expect(fixture.getInput()?.systemPrompt).toBe("Use pine mailbox inside north tower");
  expect(fixture.getInput()?.messages[0]?.content).toEqual([
    { type: "text", text: "Please use the blue basket" },
    { type: "image", url: "data:image/png;base64,abc" },
  ]);
});

it("wraps stream functions with inbound and outbound replacements", async () => {
  const fixture = transformFixture(
    {
      input: [{ from: /red basket/g, to: "blue basket" }],
      output: [
        { from: /blue basket/g, to: "red basket" },
        { from: /right shelf/g, to: "left shelf" },
      ],
      transformSystemPrompt: false,
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
    systemPrompt: "Keep red basket untouched here",
    messages: [{ role: "user", content: "Use red basket" }],
  } as Context);
  const events = await collectEvents(stream);
  const result = await stream.result();

  expect(fixture.getInput()?.systemPrompt).toBe("Keep red basket untouched here");
  expect(fixture.getInput()?.messages).toEqual([{ role: "user", content: "Use blue basket" }]);
  expect(events[0]).toMatchObject({ type: "text_delta", delta: "red basket on the left shelf" });
  expect(result.content).toEqual([{ type: "text", text: "final red basket on the left shelf" }]);
});

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
