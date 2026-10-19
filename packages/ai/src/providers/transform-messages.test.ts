import { describe, expect, it } from "vitest";
import { transformProviderMessages } from "../provider-transcript-transform.js";
import type { ProviderMessage, ProviderModel } from "../provider-types.js";
import type { AssistantMessage, Message, ToolResultMessage } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { makeProviderModel } from "./provider-model.test-support.js";
import { transformMessages } from "./transform-messages.js";

const EXPECTED_FAILURE_MARKER =
  "[This turn failed before it completed. Do not redo its work without confirming with the user first.]";
const NO_CONTENT_PLACEHOLDER = "[assistant turn failed before producing content]";

const model = makeProviderModel("openai-completions", "openai", "text-only-model", {
  name: "Text-only model",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  maxTokens: 4_096,
});
const text = (value: string) => ({ type: "text" as const, text: value });
const image = (data: string, mimeType = "image/png") => ({
  type: "image" as const,
  data,
  mimeType,
});
const user = (content: string, timestamp = 1): Message => ({ role: "user", content, timestamp });
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
): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsage(),
    timestamp: 2,
    content,
    stopReason,
  };
}

it("keeps host-sanitized repetition history through provider replay", () => {
  const message = {
    ...makeAssistant(
      [text("Earlier answer stays intact."), text("[Repetitive output stopped]")],
      "error",
    ),
    errorCode: "openclaw_repetitive_output",
  };
  expect(transformMessages([message], model)).toEqual([message]);
});

describe("aborted assistant replay at the provider boundary", () => {
  it("replaces partial text with one marker between unrelated user turns", () => {
    const before: Message = user("summarize the incident");
    const after: Message = user("what is the weather?", 3);
    const failed = makeAssistant([text("Starting the incident summary")], "aborted");

    const transformed = transformMessages([before, failed, after], model);

    expect(transformed).toEqual([
      before,
      { ...failed, content: [text(EXPECTED_FAILURE_MARKER)] },
      after,
    ]);
    expect(failed.content).toEqual([text("Starting the incident summary")]);
  });

  it("drops a failed tool-call turn even when it also contains partial text", () => {
    const prompt = user("run it");
    const failed = makeAssistant(
      [
        text("Starting the lookup"),
        { type: "toolCall", id: "call-1", name: "lookup", arguments: {} },
      ],
      "aborted",
    );

    expect(transformMessages([prompt, failed], model)).toEqual([prompt]);
  });

  it("drops the no-content placeholder with hidden reasoning across a model change", () => {
    const failed = {
      ...makeAssistant(
        [text(NO_CONTENT_PLACEHOLDER), { type: "thinking", thinking: "hidden partial reasoning" }],
        "aborted",
      ),
      model: "source-model",
    };
    const prompt = user("what is the weather?", 3);
    expect(transformMessages([failed, prompt], model)).toEqual([prompt]);
  });
});

it("preserves native same-model reasoning on a length stop", () => {
  const assistant = makeAssistant(
    [{ type: "thinking", thinking: "partial reasoning", thinkingSignature: "signed-reasoning" }],
    "length",
  );

  expect(transformMessages([assistant], model)).toEqual([assistant]);
});

describe("transformMessages", () => {
  it("normalizes null or missing content before provider transforms", () => {
    const messages = [
      { role: "user", content: null, timestamp: 1 },
      { ...makeAssistant([], "stop"), content: null },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "lookup",
        isError: false,
        timestamp: 3,
      },
    ] as unknown as ProviderMessage[];

    const transformed = transformProviderMessages(messages, model);

    expect(transformed.map((message) => message.content)).toEqual([[], [], []]);
  });

  it("replaces unsupported user media in order without exposing video bytes", () => {
    const sentinel = "video-secret-sentinel";
    const messages = [
      {
        role: "user",
        content: [
          text("before"),
          image("image-one"),
          { type: "video", data: sentinel, mimeType: "video/mp4" },
          text("after"),
          image("image-two", "image/jpeg"),
        ],
        timestamp: 1,
      },
    ] satisfies ProviderMessage[];

    const originalContent = structuredClone(messages[0].content);
    const transformed = transformProviderMessages(messages, model);

    expect(transformed[0]?.content).toEqual([
      text("before"),
      text("(image omitted: model does not support images)"),
      text("(video omitted: provider does not support video input)"),
      text("after"),
      text("(image omitted: model does not support images)"),
    ]);
    expect(JSON.stringify(transformed)).not.toContain(sentinel);

    const advertisedVideoModel: ProviderModel<"openai-completions"> = {
      ...model,
      input: ["text", "image", "video"],
    };
    const advertised = transformProviderMessages(messages, advertisedVideoModel);
    expect(advertised[0]?.content).toEqual(originalContent);

    const responsesModel = {
      ...advertisedVideoModel,
      api: "openai-responses" as const,
    } as ProviderModel<"openai-responses">;
    const responses = transformProviderMessages(messages, responsesModel);
    expect(responses[0]?.content).toContainEqual(
      text("(video omitted: provider does not support video input)"),
    );
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
    const messages: Message[] = [toolResult(content)];

    const transformed = transformMessages(messages, model);
    const projected = (transformed[0] as ToolResultMessage).content;

    expect(projected).toEqual([
      resource,
      text("(tool image omitted: model does not support images)"),
      metadata,
      text("(tool image omitted: model does not support images)"),
    ]);
    expect(projected[0]).toBe(resource);
    expect(projected[2]).toBe(metadata);
  });

  it.each([
    ["synchronous call", false, " call_1 ", "call_1"],
    ["asynchronous call", true, " call_1 ", "call_1"],
    ["asynchronous result", true, "call_1", " call_1 "],
  ] as const)(
    "pairs padded %s ids without synthesizing an error",
    (_name, async, id, toolCallId) => {
      const assistant = {
        ...makeAssistant(
          [{ type: "toolCall", id, name: "lookup", arguments: {}, ...(async ? { async } : {}) }],
          "toolUse",
        ),
        model: async ? "source-model" : model.id,
        timestamp: 1,
      };
      const messages: Message[] = [
        assistant,
        ...(async
          ? [{ ...assistant, content: [{ type: "text" as const, text: "later answer" }] }]
          : []),
        toolResult([text("actual result")], toolCallId, 2),
      ];
      const original = structuredClone(messages);

      const transformed = transformMessages(messages, model);

      expect(transformed.map((message) => message.role)).toEqual([
        "assistant",
        "toolResult",
        ...(async ? ["assistant"] : []),
      ]);
      expect(transformed[0]?.content).toEqual([
        { type: "toolCall", id: "call_1", name: "lookup", arguments: {} },
      ]);
      expect(transformed[1]).toMatchObject({
        role: "toolResult",
        toolCallId: "call_1",
        isError: false,
        content: [text("actual result")],
      });
      expect(messages).toEqual(original);
    },
  );
});
