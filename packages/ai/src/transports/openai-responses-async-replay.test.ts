import type { AssistantMessage, Context, Model, ToolResultMessage } from "@openclaw/llm-core";
import type { ResponseOutputItem } from "openai/resources/responses/responses.js";
import { expect, it } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { transformProviderMessages } from "../provider-transcript-transform.js";
import { resolveResponsesContinuationRequest } from "./openai-responses-continuation.js";
import {
  responsesInputFingerprint,
  recordResponsesInputReplay,
} from "./openai-responses-input-replay.js";
import { createAssistant, createModel } from "./openai-responses-prompt-observer.test-support.js";
import {
  convertProviderResponsesMessages,
  convertResponsesMessages,
  encodeTextSignatureV1,
} from "./openai-responses-replay-messages-internal.js";
import {
  expectTypes,
  userMessage as user,
  wireMessage,
  wireCall,
  wireUser,
} from "./openai-stream-cases.test-support.js";

const model = createModel({ id: "async-model" });
const imageModel: Model = { ...model, input: ["text", "image"] };

function answer(
  text: string,
  responseId?: string,
  signature?: string,
  turnId?: string,
): AssistantMessage {
  return createAssistant(
    model,
    [
      {
        type: "text",
        text,
        textSignature: signature ? encodeTextSignatureV1(signature) : undefined,
      },
    ],
    { responseId, turnId },
  );
}
function asyncPrefix(
  responseId: string | undefined,
  turnId?: string,
  id = "async",
): AssistantMessage {
  return createAssistant(
    model,
    [{ type: "toolCall", id: `call_${id}|fc_${id}`, name: "lookup", arguments: {}, async: true }],
    { responseId, turnId, stopReason: "toolUse" },
  );
}

it.each([
  ["provider", convertProviderResponsesMessages],
  ["transport", convertResponsesMessages],
] as const)("%s preserves tool-result caption positions and text bytes", (_name, convert) => {
  const image = (data: string) => ({ type: "image" as const, mimeType: "image/png", data });
  const text = (value: string) => ({ type: "text" as const, text: value });
  const wireImage = (data: string) => ({
    type: "input_image",
    detail: "auto",
    image_url: `data:image/png;base64,${data}`,
  });
  const wireText = (value: string) => ({ type: "input_text", text: value });
  const [image1, image2, image3] = [image("aW1n"), image("aW1nMg=="), image("aW1nMw==")] as const;
  const [wire1, wire2, wire3] = [
    wireImage("aW1n"),
    wireImage("aW1nMg=="),
    wireImage("aW1nMw=="),
  ] as const;
  const before = text("Before:"),
    after = text("After:");
  const wireBefore = wireText("Before:"),
    wireAfter = wireText("\nAfter:");
  const cases: [ToolResultMessage["content"], unknown][] = [
    [
      [before, image1, image2, after, image3],
      [wireBefore, wire1, wire2, wireAfter, wire3],
    ],
    [
      [image1, text("Caption")],
      [wire1, wireText("Caption")],
    ],
    [
      [before, text("First screen"), image1, after, text("Second screen")],
      [wireText("Before:\nFirst screen"), wire1, wireText("\nAfter:\nSecond screen")],
    ],
    [[image1], [wire1]],
    [[text("  first\n"), text(""), text("second  ")], "  first\n\nsecond  "],
  ];
  for (const [content, output] of cases) {
    const result: ToolResultMessage = {
      ...makeTextToolResult("call_compare|fc_compare", "compare", "", false, 2),
      content,
    };
    const assistant = createAssistant(
      imageModel,
      [{ type: "toolCall", id: result.toolCallId, name: "compare", arguments: {} }],
      { stopReason: "toolUse" },
    );
    const replay = convert(imageModel, { messages: [assistant, result] }, new Set(["openai"]));
    expect(replay.find((item) => item.type === "function_call_output")).toEqual({
      type: "function_call_output",
      call_id: "call_compare",
      output,
    });
  }
});

it.each([
  ["provider", convertProviderResponsesMessages],
  ["transport", convertResponsesMessages],
] as const)(
  "%s keeps retained runtime carriers with their own users when steering is appended",
  (_name, convert) => {
    const context: Context = {
      messages: ["first", "second"].flatMap((turn) => [
        user(turn),
        {
          ...user(`OpenClaw runtime context:\n${turn} context`),
          timestamp: 0,
          runtimeContext: {},
        },
        answer(`${turn} answer`),
      ]),
    };
    const original = structuredClone(context);
    const prefix = convert(model, context, new Set(["openai"]));
    const withSteering = convert(
      model,
      { messages: [...context.messages, user("steering")] },
      new Set(["openai"]),
    );
    expect(withSteering.slice(0, prefix.length)).toEqual(prefix);
    expect(withSteering).toMatchObject(
      [
        "first",
        "OpenClaw runtime context:\nfirst context",
        "first answer",
        "second",
        "OpenClaw runtime context:\nsecond context",
        "second answer",
        "steering",
      ].map((text) => ({ content: [{ text }] })),
    );
    expect(context).toEqual(original);
  },
);

it.each([
  ["provider", convertProviderResponsesMessages],
  ["transport", convertResponsesMessages],
] as const)("%s anchors mixed-media shipped carriers before async replay", (_name, convert) => {
  const prefix = asyncPrefix("resp_async");
  const tail = answer("answer", "resp_async", "msg_tail");
  const carrier = {
    role: "user" as const,
    content: [
      { type: "text" as const, text: "runtime facts" },
      { type: "image" as const, mimeType: "image/png", data: "aW1n" },
    ],
    timestamp: 2,
    runtimeContextCarrier: true as const,
  };
  const result = makeTextToolResult("call_async|fc_async", "lookup", "found", false, 3);
  const context: Context = {
    messages: [user("question"), prefix, result, carrier, tail, user("steering", 4)],
  };

  const replay = convert(imageModel, context, new Set(["openai"]));

  expectTypes(replay, [
    "message",
    "message",
    "function_call",
    "message",
    "function_call_output",
    "message",
  ]);
  expect(replay[1]).toMatchObject({
    role: "user",
    content: [
      { type: "input_text", text: "runtime facts" },
      { type: "input_image", image_url: "data:image/png;base64,aW1n" },
    ],
  });
});

it.each([
  ["provider early result", convertProviderResponsesMessages, true, false],
  ["provider late result", convertProviderResponsesMessages, false, false],
  ["transport early result", convertResponsesMessages, true, false],
  ["transport late result", convertResponsesMessages, false, false],
  ["provider terminal response identity", convertProviderResponsesMessages, true, true],
  ["transport terminal response identity", convertResponsesMessages, true, true],
] as const)(
  "%s replay preserves one async result and the incremental response prefix",
  (_name, convert, earlyResult, terminalIdentity) => {
    const turnId = terminalIdentity ? "streamed_turn" : undefined;
    const prefix = asyncPrefix(terminalIdentity ? undefined : "resp_async", turnId);
    const tail = answer("independent answer", "resp_async", "msg_tail", turnId);
    const toolResult = makeTextToolResult("call_async|fc_async", "lookup", "found", false, 2);
    const context: Context = {
      messages: [
        user("look up"),
        prefix,
        ...(earlyResult ? [toolResult, tail] : [tail, toolResult]),
      ],
    };
    const original = structuredClone(context);
    const input = convert(model, context, new Set(["openai"]));
    expectTypes(input, ["message", "function_call", "message", "function_call_output"]);
    expect(input[1]).toMatchObject({ type: "function_call", async: true, call_id: "call_async" });
    const completedCall = {
      ...wireCall("async", "lookup"),
      status: "completed",
      async: true,
    } satisfies Extract<ResponseOutputItem, { type: "function_call" }> & { async: true };
    const result = resolveResponsesContinuationRequest(
      {
        lastRequest: { model: model.id, input: input.slice(0, 1) },
        lastResponseId: "resp_async",
        lastResponseItems: [completedCall, wireMessage("msg_tail", "independent answer")],
      },
      { model: model.id, input },
    );
    expect(result.continuationStatus).toBe("continued");
    expect(result.request).toMatchObject({
      previous_response_id: "resp_async",
      input: [{ type: "function_call_output", call_id: "call_async", output: "found" }],
    });
    expect(context).toEqual(original);

    for (const target of [
      { ...model, id: "gpt-5.6-luna" },
      createModel<"anthropic-messages">({
        ...model,
        id: "claude-sonnet-4-6",
        provider: "anthropic",
        api: "anthropic-messages",
        compat: undefined,
      }),
    ]) {
      const switched = transformProviderMessages(context.messages, target);
      expect(switched).toMatchObject([
        { role: "user" },
        { role: "assistant", content: [{ type: "toolCall", id: "call_async|fc_async" }] },
        { role: "toolResult", isError: false, content: [{ type: "text", text: "found" }] },
        { role: "assistant" },
      ]);
      expect(switched[1]?.content[0]).not.toHaveProperty("async");
    }
    const switchedInput = convert({ ...model, id: "gpt-5.6-luna" }, context, new Set(["openai"]));
    expectTypes(switchedInput, ["message", "function_call", "function_call_output", "message"]);
    expect(switchedInput[1]).not.toHaveProperty("async");

    const brokenTail: AssistantMessage = {
      ...tail,
      content: [],
      stopReason: "error",
      errorMessage: "stream failed",
    };
    const interrupted = convert(
      model,
      {
        ...context,
        messages: context.messages.map((message) => (message === tail ? brokenTail : message)),
      },
      new Set(["openai"]),
    );
    expectTypes(interrupted, ["message", "function_call", "function_call_output"]);
    expect(interrupted[2]).toMatchObject({ call_id: "call_async", output: "found" });
  },
);

it.each(["before", "after"] as const)(
  "replays saved steering input %s its response after session recovery",
  (position) => {
    const call = asyncPrefix("resp_parent", undefined, "1");
    const result = makeTextToolResult("call_1|fc_1", "lookup", "found", false, 2);
    const input = { type: "function_call_output", call_id: "call_1", output: "found" };
    const response = answer("steered answer", "resp_steered", "msg_2");
    recordResponsesInputReplay(response, {
      afterResponseId: "resp_parent",
      before: [],
      after: [],
      [position]: [responsesInputFingerprint(input)],
    });
    const serialized = JSON.stringify({
      messages: [user("original", 0), call, result, user("update", 3), response],
    });
    const context: Context = JSON.parse(serialized);
    for (const convert of [convertProviderResponsesMessages, convertResponsesMessages]) {
      const replay = convert(model, context, new Set(["openai"]));
      expectTypes(replay, [
        "message",
        "function_call",
        "message",
        ...(position === "before"
          ? ["function_call_output", "message"]
          : ["message", "function_call_output"]),
      ]);
      expect(replay[2]).toMatchObject(wireUser("update"));
      expect(replay.filter((item) => item.type === "function_call_output")).toEqual([input]);
    }
  },
);
