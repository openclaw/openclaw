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

  it("does not recover downgraded text calls when structured tool calls are present", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "read",
          arguments: { path: "/tmp/demo.txt" },
        },
        {
          type: "text",
          text: 'exec({"command":"pwd"})',
        },
      ],
    };

    recoverTextToolCallsInMessage(message, new Set(["read", "exec"]));

    expect(message).toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "read",
          arguments: { path: "/tmp/demo.txt" },
        },
        {
          type: "text",
          text: 'exec({"command":"pwd"})',
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

  it("does not recover tool calls when surrounding prose is present", async () => {
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
      content: [{ type: "text", text: 'I\'ll check that. exec({"command":"ls"}) Done.' }],
    });
  });

  it("does not map provider-prefixed names to canonical allowed tools", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: 'functions.read({"path":"/tmp/a"})' }],
    };
    const baseFn = vi.fn(() => createFakeStream({ events: [], resultMessage: finalMessage }));

    const stream = await invokeRecoveredStream(baseFn, new Set(["read"]));
    const result = await stream.result();

    expect(result).toEqual({
      role: "assistant",
      content: [{ type: "text", text: 'functions.read({"path":"/tmp/a"})' }],
    });
  });

  it("does not recover tool-call examples inside markdown code fences or inline code", async () => {
    const text = `Use \`exec({"command":"pwd"})\` to inspect.
\`\`\`ts
exec({"command":"ls"})
\`\`\``;
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

  it("does not recover tool-call examples inside multi-backtick inline code spans", async () => {
    const text = `Use \`\`exec({"command":"pwd"})\`\` to inspect.`;
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

  it("does not recover tool-call examples inside tilde code fences", async () => {
    const text = `~~~ts
exec({"command":"pwd"})
~~~`;
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

  it("does not recover tool-call examples inside indented markdown code blocks", async () => {
    const text = `Try this:
    exec({"command":"pwd"})`;
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

  it("does not recover tool-call examples inside unterminated fenced code in partial streams", async () => {
    const text = `\`\`\`ts
exec({"command":"pwd"})`;
    const event = {
      type: "toolcall_delta",
      partial: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
    };
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
    };
    const baseFn = vi.fn(() => createFakeStream({ events: [event], resultMessage: finalMessage }));

    const stream = await invokeRecoveredStream(baseFn, new Set(["exec"]));
    for await (const _item of stream) {
      // drain
    }

    expect(event.partial.content).toEqual([{ type: "text", text }]);
  });

  it("does not recover tool-call examples inside unterminated inline code in partial streams", async () => {
    const text = '`exec({"command":"pwd"})';
    const event = {
      type: "toolcall_delta",
      partial: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
    };
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
    };
    const baseFn = vi.fn(() => createFakeStream({ events: [event], resultMessage: finalMessage }));

    const stream = await invokeRecoveredStream(baseFn, new Set(["exec"]));
    for await (const _item of stream) {
      // drain
    }

    expect(event.partial.content).toEqual([{ type: "text", text }]);
  });

  it("does not mutate streamed partial events before the final result", async () => {
    const text = 'exec({"command":"pwd"})';
    const event = {
      type: "toolcall_delta",
      partial: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
    };
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text }],
    };
    const baseFn = vi.fn(() => createFakeStream({ events: [event], resultMessage: finalMessage }));

    const stream = await invokeRecoveredStream(baseFn, new Set(["exec"]));
    const seenEvents: unknown[] = [];
    for await (const item of stream) {
      seenEvents.push(item);
    }
    const result = await stream.result();

    expect(seenEvents).toHaveLength(1);
    expect(event.partial.content).toEqual([{ type: "text", text }]);
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

  it("does not recover oversized text blocks", async () => {
    const finalMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `${" ".repeat(32_001)}exec({"command":"pwd"})`,
        },
      ],
    };
    const baseFn = vi.fn(() => createFakeStream({ events: [], resultMessage: finalMessage }));

    const stream = await invokeRecoveredStream(baseFn, new Set(["exec"]));
    const result = await stream.result();

    expect(result).toEqual(finalMessage);
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
