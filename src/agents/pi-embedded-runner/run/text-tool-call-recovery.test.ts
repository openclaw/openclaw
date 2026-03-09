import { describe, expect, it, vi } from "vitest";
import {
  recoverTextToolCallsInMessage,
  wrapStreamFnRecoverTextToolCalls,
} from "./text-tool-call-recovery.js";

function createFakeStream(params: { events: unknown[]; resultMessage: unknown }): {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
} {
  return {
    async result() {
      return params.resultMessage;
    },
    [Symbol.asyncIterator]() {
      return (async function* () {
        for (const event of params.events) {
          yield event;
        }
      })();
    },
  };
}

async function invokeRecoveredStream(baseFn: (...args: never[]) => unknown, allowed?: Set<string>) {
  const wrapped = wrapStreamFnRecoverTextToolCalls(baseFn as never, allowed);
  return await wrapped({} as never, {} as never, {} as never);
}

describe("recoverTextToolCallsInMessage", () => {
  it("does not touch messages that already include structured tool calls", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "exec",
          arguments: { command: "pwd" },
        },
        {
          type: "text",
          text: "Done.",
        },
      ],
    };

    recoverTextToolCallsInMessage(message, new Set(["exec"]));

    expect(message).toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "exec",
          arguments: { command: "pwd" },
        },
        {
          type: "text",
          text: "Done.",
        },
      ],
    });
  });
});

describe("wrapStreamFnRecoverTextToolCalls", () => {
  it("recovers bare text tool calls into structured toolCall blocks", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: 'exec({"command":"pwd","timeout":120000})' }],
    };
    const baseFn = vi.fn(() => createFakeStream({ events: [], resultMessage: finalMessage }));

    const stream = await invokeRecoveredStream(baseFn, new Set(["exec"]));
    const result = await stream.result();

    expect(result).toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "exec",
          arguments: { command: "pwd", timeout: 120000 },
        },
      ],
    });
  });

  it("recovers XML invoke blocks into structured toolCall blocks", async () => {
    const finalMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `<invoke name="Read">
<parameter name="path">/tmp/demo.txt</parameter>
</invoke>`,
        },
      ],
    };
    const baseFn = vi.fn(() => createFakeStream({ events: [], resultMessage: finalMessage }));

    const stream = await invokeRecoveredStream(baseFn, new Set(["read"]));
    const result = await stream.result();

    expect(result).toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "read",
          arguments: { path: "/tmp/demo.txt" },
        },
      ],
    });
  });

  it("recovers XML invoke blocks with no parameters using empty arguments", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: `<invoke name="Browser"></invoke>` }],
    };
    const baseFn = vi.fn(() => createFakeStream({ events: [], resultMessage: finalMessage }));

    const stream = await invokeRecoveredStream(baseFn, new Set(["browser"]));
    const result = await stream.result();

    expect(result).toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "browser",
          arguments: {},
        },
      ],
    });
  });

  it("preserves surrounding prose while recovering tool calls", async () => {
    const finalMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: 'I\'ll check that. exec({"command":"ls"}) Done.',
        },
      ],
    };
    const baseFn = vi.fn(() => createFakeStream({ events: [], resultMessage: finalMessage }));

    const stream = await invokeRecoveredStream(baseFn, new Set(["exec"]));
    const result = await stream.result();

    expect(result).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "I'll check that." },
        {
          type: "toolCall",
          name: "exec",
          arguments: { command: "ls" },
        },
        { type: "text", text: "Done." },
      ],
    });
  });

  it("maps provider-prefixed names to canonical allowed tools", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: 'functions.read({"path":"/tmp/a"})' }],
    };
    const baseFn = vi.fn(() => createFakeStream({ events: [], resultMessage: finalMessage }));

    const stream = await invokeRecoveredStream(baseFn, new Set(["read"]));
    const result = await stream.result();

    expect(result).toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "read",
          arguments: { path: "/tmp/a" },
        },
      ],
    });
  });

  it("does not recover tool-call examples inside markdown code fences or inline code", async () => {
    const text = 'Use `exec({"command":"pwd"})` to inspect.\\n```ts\\nexec({"command":"ls"})\\n```';
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text }],
    };
    const baseFn = vi.fn(() => createFakeStream({ events: [], resultMessage: finalMessage }));

    const stream = await invokeRecoveredStream(baseFn, new Set(["exec"]));
    const result = await stream.result();

    expect(result).toEqual({
      role: "assistant",
      content: [{ type: "text", text }],
    });
  });

  it("recovers tool calls in streamed partial events", async () => {
    const event = {
      type: "toolcall_delta",
      partial: {
        role: "assistant",
        content: [{ type: "text", text: 'exec({"command":"pwd"})' }],
      },
    };
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
    };
    const baseFn = vi.fn(() => createFakeStream({ events: [event], resultMessage: finalMessage }));

    const stream = await invokeRecoveredStream(baseFn, new Set(["exec"]));
    const seenEvents: unknown[] = [];
    for await (const item of stream) {
      seenEvents.push(item);
    }

    expect(seenEvents).toHaveLength(1);
    expect(event.partial.content).toEqual([
      {
        type: "toolCall",
        name: "exec",
        arguments: { command: "pwd" },
      },
    ]);
  });

  it("supports async stream functions that resolve to a stream", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: 'exec({"command":"pwd"})' }],
    };
    const baseFn = vi.fn(async () => createFakeStream({ events: [], resultMessage: finalMessage }));

    const stream = await invokeRecoveredStream(baseFn, new Set(["exec"]));
    const result = await stream.result();

    expect(result).toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "exec",
          arguments: { command: "pwd" },
        },
      ],
    });
  });
});
