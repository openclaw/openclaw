// MiniMax tests cover message-end stream handling.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
} from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { createMinimaxMessageEndMarkerWrapper } from "./stream.js";

const TEST_MODEL_ID = "MiniMax-M3";

function createAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "minimax",
    model: TEST_MODEL_ID,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function createToolUseMessage(text: string): AssistantMessage {
  return {
    ...createAssistantMessage(text),
    content: [
      { type: "text", text },
      { type: "toolCall", id: "call_1", name: "test", arguments: {} },
    ],
    stopReason: "toolUse",
  };
}

function createThinkingAndTextMessage(thinking: string, text: string): AssistantMessage {
  return {
    ...createAssistantMessage(text),
    content: [
      { type: "thinking", thinking },
      { type: "text", text },
    ],
  };
}

function createThinkingMessage(thinking: string): AssistantMessage {
  return {
    ...createAssistantMessage(""),
    content: [{ type: "thinking", thinking }],
  };
}

function createTextPairMessage(first: string, second: string): AssistantMessage {
  return {
    ...createAssistantMessage(second),
    content: [
      { type: "text", text: first },
      { type: "text", text: second },
    ],
  };
}

function createEventStream(
  events: AssistantMessageEvent[],
  onIteratorClose?: () => void,
): StreamFn {
  return (() => {
    const terminal = events.find((event) => event.type === "done" || event.type === "error");
    const message =
      terminal?.type === "done"
        ? terminal.message
        : terminal?.type === "error"
          ? terminal.error
          : createAssistantMessage("");
    return {
      result: async () => message,
      async *[Symbol.asyncIterator]() {
        try {
          yield* events;
        } finally {
          onIteratorClose?.();
        }
      },
    };
  }) as StreamFn;
}

async function collectEvents(stream: ReturnType<StreamFn>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream as AsyncIterable<AssistantMessageEvent>) {
    events.push(event);
  }
  return events;
}

function runWrapper(events: AssistantMessageEvent[], onIteratorClose?: () => void) {
  const wrapped = createMinimaxMessageEndMarkerWrapper(createEventStream(events, onIteratorClose));
  return wrapped(
    {
      api: "anthropic-messages",
      provider: "minimax",
      id: TEST_MODEL_ID,
    } as Model<"anthropic-messages">,
    { messages: [] } as Context,
  );
}

describe("MiniMax message-end stream wrapper", () => {
  it("withholds a split terminal marker until the text block closes", async () => {
    const text = "Done[e~[";
    const events: AssistantMessageEvent[] = [
      { type: "start", partial: createAssistantMessage("") },
      { type: "text_start", contentIndex: 0, partial: createAssistantMessage("") },
      {
        type: "text_delta",
        contentIndex: 0,
        delta: "Done[e",
        partial: createAssistantMessage("Done[e"),
      },
      { type: "text_delta", contentIndex: 0, delta: "~[", partial: createAssistantMessage(text) },
      { type: "text_end", contentIndex: 0, content: text, partial: createAssistantMessage(text) },
      { type: "done", reason: "stop", message: createAssistantMessage(text) },
    ];

    const stream = runWrapper(events);
    const output = await collectEvents(stream);
    const textDeltas = output.filter((event) => event.type === "text_delta");
    const textEnd = output.find((event) => event.type === "text_end");
    const done = output.find((event) => event.type === "done");

    expect(textDeltas.map((event) => event.delta)).toEqual(["Done"]);
    expect(textDeltas[0]?.partial?.content).toEqual([{ type: "text", text: "Done" }]);
    expect(textEnd?.type === "text_end" ? textEnd.content : undefined).toBe("Done");
    expect(done?.type === "done" ? done.message.content : undefined).toEqual([
      { type: "text", text: "Done" },
    ]);
    expect(JSON.stringify(output)).not.toContain("[e~[");
    expect(JSON.stringify(output)).not.toContain("[e");
    await expect(
      (stream as { result(): Promise<AssistantMessage> }).result(),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "Done" }],
    });
  });

  it("preserves a literal marker when later text proves it is not terminal", async () => {
    const text = "The literal [e~[ belongs in this explanation.";
    const events: AssistantMessageEvent[] = [
      { type: "start", partial: createAssistantMessage("") },
      { type: "text_start", contentIndex: 0, partial: createAssistantMessage("") },
      { type: "text_delta", contentIndex: 0, delta: "The literal [e" },
      {
        type: "text_delta",
        contentIndex: 0,
        delta: "~[ belongs in this explanation.",
        partial: createAssistantMessage(text),
      },
      { type: "text_end", contentIndex: 0, content: text, partial: createAssistantMessage(text) },
      { type: "done", reason: "stop", message: createAssistantMessage(text) },
    ];

    const stream = runWrapper(events);
    const output = await collectEvents(stream);
    const textDeltas = output.filter((event) => event.type === "text_delta");
    const lastDelta = textDeltas.at(-1);

    expect(textDeltas.map((event) => event.delta).join("")).toBe(text);
    expect(lastDelta?.type === "text_delta" ? lastDelta.partial?.content : undefined).toEqual([
      { type: "text", text },
    ]);
    expect(output.find((event) => event.type === "text_end")).toMatchObject({ content: text });
    await expect(
      (stream as { result(): Promise<AssistantMessage> }).result(),
    ).resolves.toMatchObject({
      content: [{ type: "text", text }],
    });
  });

  it("restores a completed marker before a following tool block", async () => {
    const text = "Call the tool[e~[";
    const toolUse = createToolUseMessage(text);
    const events: AssistantMessageEvent[] = [
      { type: "start", partial: createAssistantMessage("") },
      { type: "text_start", contentIndex: 0, partial: createAssistantMessage("") },
      { type: "text_delta", contentIndex: 0, delta: "Call the tool[e" },
      { type: "text_delta", contentIndex: 0, delta: "~[" },
      { type: "text_end", contentIndex: 0, content: text, partial: createAssistantMessage(text) },
      { type: "toolcall_start", contentIndex: 1, partial: toolUse },
      { type: "done", reason: "toolUse", message: toolUse },
    ];

    const output = await collectEvents(runWrapper(events));
    const textDeltas = output.filter((event) => event.type === "text_delta");
    const textEnd = output.find((event) => event.type === "text_end");
    const done = output.find((event) => event.type === "done");

    expect(textDeltas.map((event) => event.delta).join("")).toBe(text);
    expect(textEnd?.type === "text_end" ? textEnd.content : undefined).toBe(text);
    expect(done?.type === "done" ? done.message.content : undefined).toEqual(toolUse.content);
  });

  it("cleans a terminal marker after a preceding thinking block", async () => {
    const text = "Done[e~[";
    const beforeMarker = createThinkingAndTextMessage("reasoning", "Done[e");
    const fullMessage = createThinkingAndTextMessage("reasoning", text);
    const stream = runWrapper([
      { type: "start", partial: createAssistantMessage("") },
      { type: "thinking_start", contentIndex: 0, partial: createThinkingMessage("") },
      {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "reasoning",
        partial: createThinkingMessage("reasoning"),
      },
      {
        type: "thinking_end",
        contentIndex: 0,
        content: "reasoning",
        partial: createThinkingMessage("reasoning"),
      },
      {
        type: "text_start",
        contentIndex: 1,
        partial: createThinkingAndTextMessage("reasoning", ""),
      },
      { type: "text_delta", contentIndex: 1, delta: "Done[e", partial: beforeMarker },
      { type: "text_delta", contentIndex: 1, delta: "~[", partial: fullMessage },
      { type: "text_end", contentIndex: 1, content: text, partial: fullMessage },
      { type: "done", reason: "stop", message: fullMessage },
    ]);

    const output = await collectEvents(stream);
    const textDeltas = output.filter((event) => event.type === "text_delta");
    const textEnd = output.find((event) => event.type === "text_end");
    const done = output.find((event) => event.type === "done");

    expect(textDeltas.map((event) => event.delta)).toEqual(["Done"]);
    expect(textEnd).toMatchObject({ content: "Done" });
    expect(done?.type === "done" ? done.message.content : undefined).toEqual([
      { type: "thinking", thinking: "reasoning" },
      { type: "text", text: "Done" },
    ]);
    expect(JSON.stringify(output)).not.toContain("[e~[");
    expect(JSON.stringify(output)).not.toContain("[e");
  });

  it("preserves an earlier text marker while cleaning the terminal text block", async () => {
    const leadingText = "Leading[e~[";
    const terminalText = "Final[e~[";
    const leadingMessage = createAssistantMessage(leadingText);
    const fullMessage = createTextPairMessage(leadingText, terminalText);
    const output = await collectEvents(
      runWrapper([
        { type: "start", partial: createAssistantMessage("") },
        { type: "text_start", contentIndex: 0, partial: createAssistantMessage("") },
        { type: "text_delta", contentIndex: 0, delta: leadingText, partial: leadingMessage },
        {
          type: "text_end",
          contentIndex: 0,
          content: leadingText,
          partial: leadingMessage,
        },
        {
          type: "text_start",
          contentIndex: 1,
          partial: createTextPairMessage(leadingText, ""),
        },
        { type: "text_delta", contentIndex: 1, delta: terminalText, partial: fullMessage },
        { type: "text_end", contentIndex: 1, content: terminalText, partial: fullMessage },
        { type: "done", reason: "stop", message: fullMessage },
      ]),
    );

    const leadingDeltas = output.filter(
      (event): event is Extract<AssistantMessageEvent, { type: "text_delta" }> =>
        event.type === "text_delta" && event.contentIndex === 0,
    );
    const leadingTextEnd = output.find(
      (event): event is Extract<AssistantMessageEvent, { type: "text_end" }> =>
        event.type === "text_end" && event.contentIndex === 0,
    );
    const terminalTextEnd = output.find(
      (event): event is Extract<AssistantMessageEvent, { type: "text_end" }> =>
        event.type === "text_end" && event.contentIndex === 1,
    );
    const done = output.find((event) => event.type === "done");

    expect(leadingDeltas.map((event) => event.delta).join("")).toBe(leadingText);
    expect(leadingTextEnd).toMatchObject({ content: leadingText });
    expect(terminalTextEnd).toMatchObject({ content: "Final" });
    for (const event of output) {
      if (!("partial" in event) || !event.partial) {
        continue;
      }
      const terminalBlock = event.partial.content[1];
      if (terminalBlock?.type === "text") {
        expect(terminalBlock.text).not.toBe(terminalText);
      }
    }
    expect(done?.type === "done" ? done.message.content : undefined).toEqual([
      { type: "text", text: leadingText },
      { type: "text", text: "Final" },
    ]);
  });

  it("cleans a completed marker when the stream terminates with an error", async () => {
    const text = "Interrupted[e~[";
    const error = { ...createAssistantMessage(text), stopReason: "error" as const };
    const stream = runWrapper([
      { type: "start", partial: createAssistantMessage("") },
      { type: "text_start", contentIndex: 0, partial: createAssistantMessage("") },
      { type: "text_delta", contentIndex: 0, delta: "Interrupted[e" },
      { type: "text_delta", contentIndex: 0, delta: "~[" },
      { type: "text_end", contentIndex: 0, content: text, partial: createAssistantMessage(text) },
      { type: "error", reason: "error", error },
    ]);

    const output = await collectEvents(stream);
    const terminal = output.find((event) => event.type === "error");

    expect(terminal?.type === "error" ? terminal.error.content : undefined).toEqual([
      { type: "text", text: "Interrupted" },
    ]);
    await expect(
      (stream as { result(): Promise<AssistantMessage> }).result(),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "Interrupted" }],
    });
  });

  it("forwards early iterator cancellation to the source stream", async () => {
    let sourceClosed = false;
    const stream = runWrapper(
      [
        { type: "start", partial: createAssistantMessage("") },
        { type: "text_start", contentIndex: 0, partial: createAssistantMessage("") },
      ],
      () => {
        sourceClosed = true;
      },
    );
    const iterator = (stream as AsyncIterable<AssistantMessageEvent>)[Symbol.asyncIterator]();

    await iterator.next();
    await iterator.return?.();

    expect(sourceClosed).toBe(true);
  });

  it("closes the source iterator after a terminal event", async () => {
    let sourceClosed = false;
    const text = "Done[e~[";
    const stream = runWrapper(
      [
        { type: "start", partial: createAssistantMessage("") },
        { type: "text_start", contentIndex: 0, partial: createAssistantMessage("") },
        { type: "text_delta", contentIndex: 0, delta: text, partial: createAssistantMessage(text) },
        { type: "text_end", contentIndex: 0, content: text, partial: createAssistantMessage(text) },
        { type: "done", reason: "stop", message: createAssistantMessage(text) },
      ],
      () => {
        sourceClosed = true;
      },
    );

    await collectEvents(stream);

    expect(sourceClosed).toBe(true);
  });
});
