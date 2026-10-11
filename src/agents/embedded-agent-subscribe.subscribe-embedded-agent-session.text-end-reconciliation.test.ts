import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
  extractTextPayloads,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { textAssistant } from "./test-helpers/sparse-transcript.test-support.js";

type Options = Omit<Parameters<typeof createSubscribedSessionHarness>[0], "runId">;
type NativeMessage = Pick<AssistantMessage, "role" | "content"> & {
  api: string;
  provider: string;
  model: string;
};
function assistant(texts: string[]): NativeMessage {
  return {
    role: "assistant",
    api: "google-generative-ai",
    provider: "google",
    model: "gemini-2.5-flash",
    content: texts.map((text) => ({ type: "text", text })),
  };
}
function setup(options: Options = {}) {
  const onBlockReply = vi.fn();
  const harness = createSubscribedSessionHarness({
    runId: "run",
    onBlockReply,
    blockReplyBreak: "text_end",
    ...options,
  });
  onTestFinished(() => harness.subscription.unsubscribe());
  const { emit } = harness;
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
    onBlockReply,
    texts: () => extractTextPayloads(onBlockReply.mock.calls),
    start: () => emit({ type: "message_start", message: assistant([]) }),
    delta: (texts: string[], index: number, delta = texts[index] ?? "") =>
      nativeEvent("text_delta", assistant(texts), index, delta),
    end: (texts: string[], index: number) =>
      nativeEvent("text_end", assistant(texts), index, texts[index] ?? ""),
    nativeEvent,
    toolStart: (toolName: string, toolCallId: string, args: Record<string, unknown> = {}) =>
      emit({ type: "tool_execution_start", toolName, toolCallId, args }),
  };
}
const sentenceChunking = { minChars: 10, maxChars: 16, breakPreference: "sentence" as const };

describe("native snapshot reconciliation", () => {
  it("restarts after a vanished native scope", async () => {
    const h = setup();
    h.start();
    const original = ["First", "Second"];
    for (const [index, delta] of original.entries()) {
      const texts = original.slice(0, index + 1);
      h.delta(texts, index, delta);
      h.end(texts, index);
      await h.subscription.waitForPendingEvents();
      expect(h.texts()).toEqual(texts);
    }
    h.end(["First", ""], 1);
    await h.subscription.waitForPendingEvents();
    expect(h.texts()).toEqual(original);
    h.emit({ type: "message_end", message: assistant(["Replacement"]) });
    await h.subscription.waitForPendingEvents();
    expect(h.texts()).toEqual([...original, "Replacement"]);
    expect(h.onBlockReply).toHaveBeenCalledTimes(3);
  });

  it("preserves an orphan-close replacement after a drained raw prefix", async () => {
    const onAgentEvent = vi.fn();
    const h = setup({ onAgentEvent, blockReplyChunking: sentenceChunking });
    const answer = "This is the complete visible answer.";
    let raw = "";
    h.start();
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
    h.emit({ type: "message_end", message: assistant([raw]) });
    await h.subscription.waitForPendingEvents();
    expect(h.texts()).toEqual(delivered);
    expect(onAgentEvent.mock.calls.at(-1)?.[0]).toMatchObject({
      stream: "assistant",
      data: { text: answer },
    });
  });

  it("terminal checkpoint replaces code with real reply intent", async () => {
    const onAgentEvent = vi.fn();
    const h = setup({ onAgentEvent });
    const draft = "```text\n[[reply_to:example-id]]\n```\n\nThe original draft continues here.";
    h.start();
    h.delta([draft], 0);
    expect(onAgentEvent.mock.calls.at(-1)?.[0]).toMatchObject({
      stream: "assistant",
      data: { text: draft },
    });
    onAgentEvent.mockClear();
    h.end(["[[reply_to:replacement]]Corrected"], 0);
    await h.subscription.waitForPendingEvents();
    expect({
      events: onAgentEvent.mock.calls.map(([event]) => event),
      blocks: h.texts(),
      assistantTexts: h.subscription.assistantTexts,
    }).toMatchObject({
      events: [{ stream: "assistant", data: { text: "Corrected", delta: "", replace: true } }],
      blocks: ["Corrected"],
      assistantTexts: ["Corrected"],
    });
    expect(h.onBlockReply).toHaveBeenCalledTimes(1);
    expect(h.onBlockReply.mock.calls.at(-1)?.[0]).toMatchObject({
      replyToId: "replacement",
      replyToTag: true,
    });
  });

  it.each([
    { name: "shortened", checkpoint: "Hello world. Next sentence.", tail: [] },
    {
      name: "corrected identical tail",
      checkpoint: "Hello world. Hello world.",
      tail: ["Hello world."],
    },
  ])("preserves delivered sentence chunks at a $name checkpoint", async ({ checkpoint, tail }) => {
    const h = setup({ blockReplyChunking: sentenceChunking });
    const first = "First block.";
    const delivered = [first, "Hello world.", "Next sentence."];
    h.start();
    h.delta([first], 0);
    h.end([first], 0);
    await h.subscription.waitForPendingEvents();
    expect(h.texts()).toEqual([first]);
    let second = "";
    for (const delta of ["Hello world. ", "Next sentence. ", "Tail"]) {
      second += delta;
      h.delta([first, second], 1, delta);
    }
    await h.subscription.waitForPendingEvents();
    expect(h.texts()).toEqual(delivered);
    expect(h.subscription.assistantTexts).toEqual(delivered);
    h.end([first, checkpoint], 1);
    await h.subscription.waitForPendingEvents();
    expect(h.texts()).toEqual([...delivered, ...tail]);
    expect(h.subscription.assistantTexts).toEqual([...delivered, ...tail]);
    expect(h.onBlockReply).toHaveBeenCalledTimes(delivered.length + tail.length);
  });

  it("keeps native code continuation fenced after a shortened open-fence checkpoint", async () => {
    const h = setup({ blockReplyChunking: { minChars: 1, maxChars: 20 } });
    const shortened = "```txt\nabc";
    const continuation = "defghijklmnopqrstuvwxyz\n```";
    const firstChunk = "```txt\nabcdefghi\n```";
    h.start();
    let text = "";
    for (const delta of ["`", "``txt\n", "abc", "def", "ghi", "jklmnop"]) {
      text += delta;
      h.delta([text], 0, delta);
    }
    await h.subscription.waitForPendingEvents();
    expect(h.texts()).toEqual([firstChunk]);
    h.end([shortened], 0);
    await h.subscription.waitForPendingEvents();
    expect(h.texts()).toEqual([firstChunk]);
    expect(h.onBlockReply).toHaveBeenCalledTimes(1);
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
    h.emit({ type: "message_end", message: assistant([shortened, continuation]) });
    await h.subscription.waitForPendingEvents();
    expect(h.texts()).toEqual(delivered);
    expect(h.onBlockReply).toHaveBeenCalledTimes(delivered.length);
  });

  it("delivers identical text first seen in a distinct block at message_end", async () => {
    const onAgentEvent = vi.fn();
    const h = setup({ onAgentEvent });
    h.start();
    h.delta(["Same"], 0);
    h.end(["Same"], 0);
    await h.subscription.waitForPendingEvents();
    expect(h.texts()).toEqual(["Same"]);
    expect(h.subscription.assistantTexts).toEqual(["Same"]);
    h.emit({ type: "message_end", message: assistant(["Same", "Same"]) });
    await h.subscription.waitForPendingEvents();
    expect(h.texts()).toEqual(["Same", "Same"]);
    expect(h.subscription.assistantTexts).toEqual(["Same", "Same"]);
    expect(h.onBlockReply).toHaveBeenCalledTimes(2);
    expect(onAgentEvent.mock.calls.at(-1)?.[0]).toMatchObject({
      stream: "assistant",
      data: { text: "Same\nSame" },
    });
  });

  it("does not read future blocks from shared mutable text_end partials", async () => {
    const onAgentEvent = vi.fn();
    const h = setup({ onAgentEvent });
    const partial: NativeMessage = {
      ...assistant([]),
      content: [
        { type: "text", text: "First" },
        { type: "thinking", thinking: "Private reasoning" },
        { type: "text", text: "Second" },
      ],
    };
    h.emit({ type: "message_start", message: partial });
    for (const [index, text, expected] of [
      [0, "First", ["First"]],
      [2, "Second", ["First", "Second"]],
    ] as const) {
      h.nativeEvent("text_delta", partial, index, text);
      h.nativeEvent("text_end", partial, index, text);
      await h.subscription.waitForPendingEvents();
      expect(h.texts()).toEqual(expected);
      expect(h.subscription.assistantTexts).toEqual(expected);
      expect(onAgentEvent.mock.calls.at(-1)?.[0]).toMatchObject({
        stream: "assistant",
        data: { text: expected.join("\n") },
      });
    }
    h.emit({ type: "message_end", message: partial });
    await h.subscription.waitForPendingEvents();
    expect(h.texts()).toEqual(["First", "Second"]);
    expect(h.subscription.assistantTexts).toEqual(["First", "Second"]);
    expect(h.onBlockReply).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "reasoning tags",
      chunks: ["<thi", "nk>sensitive reasoning</think>Hello"],
      enforceFinalTag: false,
      expected: ["Hello"],
    },
    {
      name: "final tags",
      chunks: ["<fi", "nal>Hello</final>"],
      enforceFinalTag: true,
      expected: ["Hello"],
    },
    {
      name: "fence literals",
      chunks: ["``", "`\n<think>literal</think>\n```\n"],
      enforceFinalTag: false,
      expected: ["```\n<think>literal</think>\n```"],
    },
  ])(
    "preserves $name split across native blocks at a checkpoint",
    async ({ chunks, enforceFinalTag, expected }) => {
      const onAgentEvent = vi.fn();
      const h = setup({ onAgentEvent, enforceFinalTag });
      const visibleUpdates = () =>
        onAgentEvent.mock.calls
          .filter(([event]) => event.stream === "assistant")
          .map(([event]) => event.data.text);
      h.start();
      for (const [index, delta] of chunks.entries()) {
        h.delta(chunks.slice(0, index + 1), index, delta);
        expect(visibleUpdates()).toEqual(index === chunks.length - 1 ? expected : []);
      }
      h.end(chunks, chunks.length - 1);
      await h.subscription.waitForPendingEvents();
      expect({
        events: visibleUpdates(),
        blocks: h.texts(),
        assistantTexts: h.subscription.assistantTexts,
      }).toEqual({ events: expected, blocks: expected, assistantTexts: expected });
      h.emit({ type: "message_end", message: assistant(chunks) });
      await h.subscription.waitForPendingEvents();
      expect(visibleUpdates()).toEqual(expected);
      expect(h.subscription.assistantTexts).toEqual(expected);
      expect(h.onBlockReply).toHaveBeenCalledTimes(expected.length);
    },
  );
});

describe("text_end replay and tool handoff", () => {
  it("ignores an already-contained snapshot", async () => {
    const h = setup();
    emitAssistantTextDelta({ emit: h.emit, delta: "Hello world" });
    emitAssistantTextEnd({ emit: h.emit, content: "world" });
    await h.subscription.waitForPendingEvents();
    expect(h.onBlockReply).toHaveBeenCalledTimes(1);
    expect(h.subscription.assistantTexts).toEqual(["Hello world"]);
  });

  it("sends only the new suffix when replies grow across tool calls", async () => {
    const h = setup();
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
      h.emit({ type: "message_start", message: { role: "assistant" } });
      emitAssistantTextEnd({ emit: h.emit, content: expected.slice(0, index + 1).join("") });
      await h.subscription.waitForPendingEvents();
      expect(h.onBlockReply).toHaveBeenCalledTimes(index + 1);
    }
    expect(h.texts()).toEqual(expected);
    expect(h.subscription.assistantTexts).toEqual(expected);
  });

  it("does not safety-send a cumulative reply whose suffix a messaging tool sent", async () => {
    const h = setup();
    h.emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextEnd({ emit: h.emit, content: "Checking:" });
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
    h.emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextEnd({ emit: h.emit, content: "Checking: Fetched prices" });
    await Promise.resolve();
    h.emit({ type: "message_end", message: textAssistant("Checking: Fetched prices") });
    await h.subscription.waitForPendingEvents();
    expect(h.texts()).toEqual(["Checking:"]);
  });

  it("preserves split reply directives after a delivered chunk through text_end", async () => {
    const h = setup({
      blockReplyChunking: { minChars: 13, maxChars: 13, breakPreference: "newline" },
    });
    h.start();
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
    await h.subscription.waitForPendingEvents();
    expect(h.texts()).toEqual(["Visible text.", "Bye"]);
    expect(h.onBlockReply.mock.calls.at(-1)?.[0]).toMatchObject({
      text: "Bye",
      replyToId: "target",
      replyToTag: true,
    });
  });

  it("keeps the completed assistant independent from transcript mutation", () => {
    const { emit, subscription } = createSubscribedSessionHarness({ runId: "run" });
    onTestFinished(() => subscription.unsubscribe());
    const message = textAssistant("Current run reply");
    emit({ type: "message_end", message });
    message.content = [{ type: "text", text: "Rewritten transcript reply" }];
    expect(subscription.getCurrentAttemptAssistant()?.content).toEqual([
      { type: "text", text: "Current run reply" },
    ]);
  });
});
