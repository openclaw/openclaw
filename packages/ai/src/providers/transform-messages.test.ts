import { afterEach, expect, it, vi } from "vitest";
import { transformProviderMessages } from "../provider-transcript-transform.js";
import type { ProviderMessage, ProviderModel } from "../provider-types.js";
import { createAssistantOutput } from "../transports/assistant-output.js";
import type { AssistantMessage, Message, ToolResultMessage } from "../types.js";
import { makeProviderModel } from "./provider-model.test-support.js";
import { transformMessages } from "./transform-messages.js";

const EXPECTED_FAILURE_MARKER =
  "[This turn failed before it completed. Do not redo its work without confirming with the user first.]";
const NO_CONTENT_PLACEHOLDER = "[assistant turn failed before producing content]";
const model = makeProviderModel("openai-completions", "openai", "text-only-model");
afterEach(() => vi.restoreAllMocks());
const text = (value: string) => ({ type: "text" as const, text: value });
const omittedImage = text("(image omitted: model does not support images)");
const omittedVideo = text("(video omitted: provider does not support video input)");
function image(data: string, mimeType = "image/png") {
  return { type: "image" as const, data, mimeType };
}
const user = (content: string, timestamp = 1): Message => ({ role: "user", content, timestamp });
const call = (id = "call_1", async?: boolean) => ({
  type: "toolCall" as const,
  id,
  name: "lookup",
  arguments: {},
  ...(async ? { async } : {}),
});
function toolResult(
  content: ToolResultMessage["content"],
  toolCallId = "call_1",
  timestamp = 1,
): ToolResultMessage {
  return { role: "toolResult", toolCallId, toolName: "lookup", content, isError: false, timestamp };
}

function makeAssistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    ...createAssistantOutput(model),
    timestamp: 2,
    content,
    stopReason,
    ...overrides,
  };
}

it("replays missing synchronous and delayed asynchronous results with their original timestamps", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const messages: Message[] = [
    makeAssistant([call("sync"), call("async", true)], "toolUse", { timestamp: 0 }),
    makeAssistant([text("later fragment")], "stop", { timestamp: 3 }),
  ];
  const first = transformMessages(messages, model);
  clock.mockReturnValue(2_000);
  const next = transformMessages(structuredClone(messages), model);

  expect(next).toEqual(first);
  expect(next.filter((message) => message.role === "toolResult")).toMatchObject([
    { toolCallId: "sync", timestamp: 0, isError: true },
    { toolCallId: "async", timestamp: 0, isError: true },
  ]);
  const recorded = toolResult([text("recorded result")], "async", 19);
  const withRecorded = transformMessages([...messages, recorded], model);
  expect(withRecorded.at(-1)).toEqual(recorded);
  expect(messages.map(({ role }) => role)).toEqual(["assistant", "assistant"]);
});

it.each([
  makeAssistant(
    [text("Earlier answer stays intact."), text("[Repetitive output stopped]")],
    "error",
    {
      errorCode: "openclaw_repetitive_output",
    },
  ),
  makeAssistant(
    [{ type: "thinking", thinking: "partial reasoning", thinkingSignature: "signed-reasoning" }],
    "length",
  ),
])("preserves same-model $stopReason history", (message) => {
  expect(transformMessages([message], model)).toEqual([message]);
});

it.each(["partial text", "partial tool-call turn", "placeholder with hidden reasoning"])(
  "replays aborted %s without unfinished work",
  (kind) => {
    const placeholder = kind === "placeholder with hidden reasoning";
    const marker = kind === "partial text";
    const content: AssistantMessage["content"] = placeholder
      ? [text(NO_CONTENT_PLACEHOLDER), { type: "thinking", thinking: "hidden partial reasoning" }]
      : [text("Starting the incident summary"), ...(marker ? [] : [call("call-1")])];
    const before = placeholder ? [] : [user("summarize the incident")];
    const after = marker || placeholder ? [user("what is the weather?", 3)] : [];
    const failed = makeAssistant(content, "aborted", placeholder ? { model: "source-model" } : {});
    const original = structuredClone(failed);
    expect(transformMessages([...before, failed, ...after], model)).toEqual([
      ...before,
      ...(marker ? [{ ...failed, content: [text(EXPECTED_FAILURE_MARKER)] }] : []),
      ...after,
    ]);
    expect(failed).toEqual(original);
  },
);
it("normalizes null or missing content before provider transforms", () => {
  const { content: _content, ...missingContent } = toolResult([]);
  const messages = [
    { role: "user", content: null, timestamp: 1 },
    { ...makeAssistant([], "stop"), content: null },
    missingContent,
  ] as unknown as ProviderMessage[];

  const contents = transformProviderMessages(messages, model).map(({ content }) => content);
  expect(contents).toEqual([[], [], []]);
});

it("replaces unsupported user media in order without exposing video bytes", () => {
  const sentinel = "video-secret-sentinel";
  const content = [
    text("before"),
    image("image-one"),
    { type: "video" as const, data: sentinel, mimeType: "video/mp4" },
    text("after"),
    image("image-two", "image/jpeg"),
  ];
  const messages = [{ role: "user", content, timestamp: 1 }] satisfies [ProviderMessage];
  const originalContent = structuredClone(content);
  const transformed = transformProviderMessages(messages, model);

  expect(transformed[0]?.content).toEqual([
    text("before"),
    omittedImage,
    omittedVideo,
    text("after"),
    omittedImage,
  ]);
  expect(JSON.stringify(transformed)).not.toContain(sentinel);

  const advertisedVideoModel: ProviderModel<"openai-completions"> = {
    ...model,
    input: ["text", "image", "video"],
  };
  expect(transformProviderMessages(messages, advertisedVideoModel)[0]?.content).toEqual(
    originalContent,
  );
  const responses = transformProviderMessages(messages, {
    ...advertisedVideoModel,
    api: "openai-responses",
  });
  expect(responses[0]?.content).toContainEqual(omittedVideo);
  expect(JSON.stringify(responses)).not.toContain(sentinel);
});

it("preserves structured tool blocks while projecting only real images", () => {
  const resource = { type: "resource", uri: "file:///tmp/result.json" };
  const metadata = { type: "metadata", value: { count: 2 } };
  const content = [
    resource,
    image("image-one"),
    image(""),
    image("image-two", "image/jpeg"),
    metadata,
    image("image-three", "image/webp"),
  ] as unknown as ToolResultMessage["content"];
  const projected = (transformMessages([toolResult(content)], model)[0] as ToolResultMessage)
    .content;
  const omitted = text("(tool image omitted: model does not support images)");
  expect(projected).toEqual([resource, omitted, metadata, omitted]);
  expect(projected[0]).toBe(resource);
  expect(projected[2]).toBe(metadata);
});

it.each([
  ["synchronous call", false, " call_1 ", "call_1"],
  ["asynchronous call", true, " call_1 ", "call_1"],
  ["asynchronous result", true, "call_1", " call_1 "],
] as const)("pairs padded %s ids", (_name, async, id, toolCallId) => {
  const assistant = makeAssistant([call(id, async)], "toolUse", {
    model: async ? "source-model" : model.id,
    timestamp: 1,
  });
  const later = async ? [{ ...assistant, content: [text("later answer")] }] : [];
  const recorded = toolResult([text("actual result")], toolCallId, 2);
  const messages: Message[] = [assistant, ...later, recorded];
  const original = structuredClone(messages);

  expect(transformMessages(messages, model)).toEqual([
    { ...assistant, content: [call()] },
    { ...recorded, toolCallId: "call_1" },
    ...later,
  ]);
  expect(messages).toEqual(original);
});
