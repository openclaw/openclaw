import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { expect, it, vi } from "vitest";
import { createDeliveryHarness } from "./embedded-agent-subscribe.delivery.test-support.js";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { textAssistant } from "./test-helpers/sparse-transcript.test-support.js";

type Options = Omit<Parameters<typeof createSubscribedSessionHarness>[0], "runId">;
type NativeMessage = Pick<AssistantMessage, "role" | "content"> &
  Record<"api" | "provider" | "model", string>;
function assistant(texts: readonly string[]): NativeMessage {
  return {
    role: "assistant",
    api: "google-generative-ai",
    provider: "google",
    model: "gemini-2.5-flash",
    content: texts.map((text) => ({ type: "text", text })),
  };
}
function setup(options: Options = {}, startNative = true) {
  const onAgentEvent = vi.fn();
  const harness = createDeliveryHarness({ onAgentEvent, ...options });
  const { emit } = harness;
  if (startNative) {
    emit({ type: "message_start", message: assistant([]) });
  }
  function nativeEvent(
    type: "text_delta" | "text_end",
    message: NativeMessage,
    index: number,
    text: string,
  ) {
    emit({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type,
        contentIndex: index,
        ...(type === "text_delta" ? { delta: text } : { content: text }),
        partial: message,
      },
    });
  }
  return {
    ...harness,
    finish: (texts: readonly string[]) => emit({ type: "message_end", message: assistant(texts) }),
    plainStart: () => emit({ type: "message_start", message: { role: "assistant" } }),
    plainEnd: (content: string) => emitAssistantTextEnd({ emit, content }),
    delta: (texts: readonly string[], index: number, delta = texts[index] ?? "") =>
      nativeEvent("text_delta", assistant(texts), index, delta),
    end: (texts: readonly string[], index: number) =>
      nativeEvent("text_end", assistant(texts), index, texts[index] ?? ""),
    nativeEvent,
    expectEvent: (text: string) =>
      expect(onAgentEvent.mock.calls.at(-1)?.[0]).toMatchObject({
        stream: "assistant",
        data: { text },
      }),
    events: onAgentEvent,
    toolStart: (toolName: string, toolCallId: string, args: Record<string, unknown> = {}) =>
      emit({ type: "tool_execution_start", toolName, toolCallId, args }),
  };
}
const sentenceChunking = { minChars: 10, maxChars: 16, breakPreference: "sentence" as const };

it("restarts after a vanished native scope", async () => {
  const h = setup();
  const original = ["First", "Second"];
  for (const [index, delta] of original.entries()) {
    const texts = original.slice(0, index + 1);
    h.delta(texts, index, delta);
    h.end(texts, index);
    await h.flush(texts);
  }
  h.end(["First", ""], 1);
  await h.flush(original);
  h.finish(["Replacement"]);
  await h.flush([...original, "Replacement"], false, 3);
});

it("preserves an orphan-close replacement after a drained raw prefix", async () => {
  const h = setup({ blockReplyChunking: sentenceChunking });
  const answer = "This is the complete visible answer.";
  let raw = "";
  for (const [index, delta] of ["private chain. ", `</mm:think>${answer}`].entries()) {
    raw += delta;
    h.delta([raw], 0, delta);
    await h.subscription.waitForPendingEvents();
    if (index === 0) {
      expect(h.texts()).toEqual(["private chain."]);
    }
  }
  h.end([raw], 0);
  await h.subscription.waitForPendingEvents();
  const delivered = h.texts();
  expect(delivered[0]).toBe("private chain.");
  expect(delivered.slice(1).join(" ")).toBe(answer);
  h.finish([raw]);
  await h.flush(delivered);
  h.expectEvent(answer);
});

it("terminal checkpoint replaces code with real reply intent", async () => {
  const h = setup();
  const draft = "```text\n[[reply_to:example-id]]\n```\n\nThe original draft continues here.";
  h.delta([draft], 0);
  h.expectEvent(draft);
  h.events.mockClear();
  h.end(["[[reply_to:replacement]]Corrected"], 0);
  await h.flush(["Corrected"], true, 1);
  expect(h.events.mock.calls.map(([event]) => event)).toMatchObject([
    { stream: "assistant", data: { text: "Corrected", delta: "", replace: true } },
  ]);
  expect(h.onBlockReply.mock.calls.at(-1)?.[0]).toMatchObject({
    replyToId: "replacement",
    replyToTag: true,
  });
});

it("preserves delivered sentence chunks at a shortened checkpoint", async () => {
  const checkpoint = "Hello world. Next sentence.";
  const h = setup({ blockReplyChunking: sentenceChunking });
  const first = "First block.";
  const delivered = [first, "Hello world.", "Next sentence."];
  h.delta([first], 0);
  h.end([first], 0);
  await h.flush([first]);
  let second = "";
  for (const delta of ["Hello world. ", "Next sentence. ", "Tail"]) {
    second += delta;
    h.delta([first, second], 1, delta);
  }
  await h.flush(delivered, true);
  h.end([first, checkpoint], 1);
  await h.flush(delivered, true, delivered.length);
});

it("keeps native code continuation fenced after a shortened open-fence checkpoint", async () => {
  const h = setup({ blockReplyChunking: { minChars: 1, maxChars: 20 } });
  const shortened = "```txt\nabc";
  const continuation = "defghijklmnopqrstuvwxyz\n```";
  const firstChunk = "```txt\nabcdefghi\n```";
  let text = "";
  for (const delta of ["`", "``txt\n", "abc", "def", "ghi", "jklmnop"]) {
    text += delta;
    h.delta([text], 0, delta);
  }
  await h.flush([firstChunk]);
  h.end([shortened], 0);
  await h.flush([firstChunk], false, 1);
  h.delta([shortened, continuation], 1);
  h.end([shortened, continuation], 1);
  await h.subscription.waitForPendingEvents();
  const delivered = h.texts();
  expect(delivered[0]).toBe(firstChunk);
  const bodies = delivered.slice(1).map((chunk) => {
    expect(chunk.startsWith("```txt\n")).toBe(true);
    expect(chunk.endsWith("\n```")).toBe(true);
    expect(chunk.length).toBeLessThanOrEqual(20);
    return chunk.slice("```txt\n".length, -"\n```".length).replaceAll("\n", "");
  });
  expect(bodies.join("")).toBe("defghijklmnopqrstuvwxyz");
  h.finish([shortened, continuation]);
  await h.flush(delivered, false, delivered.length);
});

it("delivers identical text first seen in a distinct block at message_end", async () => {
  const h = setup();
  h.delta(["Same"], 0);
  h.end(["Same"], 0);
  await h.flush(["Same"], true);
  h.finish(["Same", "Same"]);
  await h.flush(["Same", "Same"], true, 2);
  h.expectEvent("Same\nSame");
});

it("does not read future blocks from shared mutable text_end partials", async () => {
  const h = setup({}, false);
  const partial = assistant(["First", "Second"]);
  partial.content.splice(1, 0, { type: "thinking", thinking: "Private reasoning" });
  h.emit({ type: "message_start", message: partial });
  for (const [index, text, expected] of [
    [0, "First", ["First"]],
    [2, "Second", ["First", "Second"]],
  ] as const) {
    h.nativeEvent("text_delta", partial, index, text);
    h.nativeEvent("text_end", partial, index, text);
    await h.flush(expected, true);
    h.expectEvent(expected.join("\n"));
  }
  h.emit({ type: "message_end", message: partial });
  await h.flush(["First", "Second"], true, 2);
});

it.each([
  ["reasoning tags", ["<thi", "nk>sensitive reasoning</think>Hello"], false, ["Hello"]],
  ["final tags", ["<fi", "nal>Hello</final>"], true, ["Hello"]],
  [
    "fence literals",
    ["``", "`\n<think>literal</think>\n```\n"],
    false,
    ["```\n<think>literal</think>\n```"],
  ],
] as const)(
  "preserves %s split across native blocks at a checkpoint",
  async (_name, chunks, enforceFinalTag, expected) => {
    const h = setup({ enforceFinalTag });
    const visibleUpdates = () =>
      h.events.mock.calls
        .filter(([event]) => event.stream === "assistant")
        .map(([event]) => event.data.text);
    for (const [index, delta] of chunks.entries()) {
      h.delta(chunks.slice(0, index + 1), index, delta);
      expect(visibleUpdates()).toEqual(index === chunks.length - 1 ? expected : []);
    }
    h.end(chunks, chunks.length - 1);
    await h.flush(expected, true);
    expect(visibleUpdates()).toEqual(expected);
    h.finish(chunks);
    await h.flush(expected, true, expected.length);
    expect(visibleUpdates()).toEqual(expected);
  },
);
it("ignores an already-contained snapshot", async () => {
  const h = setup({}, false);
  emitAssistantTextDelta({ emit: h.emit, delta: "Hello world" });
  h.plainEnd("world");
  await h.flush(["Hello world"], true, 1);
});

it("sends only the new suffix when replies grow across tool calls", async () => {
  const h = setup({}, false);
  const expected = [
    "Let me grab actual eBay prices:",
    "Let me grab actual prices from eBay:",
    "eBay blocks live pricing:",
  ];
  for (let index = 0; index < expected.length; index++) {
    if (index > 0) {
      h.toolStart("browser", `tool-${index}`);
      await Promise.resolve();
    }
    h.plainStart();
    h.plainEnd(expected.slice(0, index + 1).join(""));
    await h.subscription.waitForPendingEvents();
    expect(h.onBlockReply).toHaveBeenCalledTimes(index + 1);
  }
  await h.flush(expected, true);
});

it("does not safety-send a cumulative reply whose suffix a messaging tool sent", async () => {
  const h = setup({}, false);
  h.plainStart();
  h.plainEnd("Checking:");
  await h.subscription.waitForPendingEvents();
  expect(h.onBlockReply).toHaveBeenCalledTimes(1);
  h.toolStart("message", "message-tool-1", {
    action: "send",
    to: "+1555",
    message: "Fetched prices",
  });
  await Promise.resolve();
  h.emit({
    type: "tool_execution_end",
    toolName: "message",
    toolCallId: "message-tool-1",
    isError: false,
    result: { details: { status: "sent" } },
  });
  await h.subscription.waitForPendingEvents();
  h.plainStart();
  h.plainEnd("Checking: Fetched prices");
  await Promise.resolve();
  h.emit({ type: "message_end", message: textAssistant("Checking: Fetched prices") });
  await h.flush(["Checking:"]);
});

it("preserves split reply directives after a delivered chunk through text_end", async () => {
  const h = setup({
    blockReplyChunking: { minChars: 13, maxChars: 13, breakPreference: "newline" },
  });
  for (const delta of ["Visible text.\n[[reply_to:", "target]]Bye"]) {
    emitAssistantTextDelta({ emit: h.emit, delta });
    expect(h.texts()).toEqual(["Visible text."]);
  }
  const text = "Visible text.\n[[reply_to:target]]Bye";
  const message = assistant([text]);
  h.emit({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "text_end", content: text, partial: message },
  });
  await h.flush(["Visible text.", "Bye"]);
  expect(h.onBlockReply.mock.calls.at(-1)?.[0]).toMatchObject({
    text: "Bye",
    replyToId: "target",
    replyToTag: true,
  });
});

it("keeps the completed assistant independent from transcript mutation", () => {
  const { emit, subscription } = setup({}, false);
  const message = textAssistant("Current run reply");
  emit({ type: "message_end", message });
  message.content = [{ type: "text", text: "Rewritten transcript reply" }];
  expect(subscription.getCurrentAttemptAssistant()?.content).toEqual([
    { type: "text", text: "Current run reply" },
  ]);
});
