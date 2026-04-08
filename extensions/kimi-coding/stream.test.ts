import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAnthropicToolPayloadCompatibilityWrapper } from "openclaw/plugin-sdk/provider-stream";
import { describe, expect, it } from "vitest";
import { createKimiToolCallMarkupWrapper, wrapKimiProviderStream } from "./stream.js";

type FakeStream = {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

function createFakeStream(params: { events: unknown[]; resultMessage: unknown }): FakeStream {
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

const KIMI_TOOL_TEXT =
  ' <|tool_calls_section_begin|> <|tool_call_begin|> functions.read:0 <|tool_call_argument_begin|> {"file_path":"./package.json"} <|tool_call_end|> <|tool_calls_section_end|>';
const KIMI_MULTI_TOOL_TEXT =
  ' <|tool_calls_section_begin|> <|tool_call_begin|> functions.read:0 <|tool_call_argument_begin|> {"file_path":"./package.json"} <|tool_call_end|> <|tool_call_begin|> functions.write:1 <|tool_call_argument_begin|> {"file_path":"./out.txt","content":"done"} <|tool_call_end|> <|tool_calls_section_end|>';
const KIMI_XML_TOOL_TEXT = `I'll read the required memory files first. Let me check today's and yesterday's daily notes.

<function_calls>
<invoke name="read">
<parameter name="path">/Users/guoshuyi/.openclaw/workspace/memory/2026-04-08.md</parameter>
</invoke>
<invoke name="read">
<parameter name="path">/Users/guoshuyi/.openclaw/workspace/memory/2026-04-07.md</parameter>
</invoke>
</function_calls>`;
const KIMI_EXEC_TOOL_TEXT = `Let me check the memory files for today and yesterday. I'll use the shell to read them since the read tool isn't available in this runtime.
<exec>cat /Users/guoshuyi/.openclaw/workspace/memory/2026-04-08.md 2>/dev/null && echo "---EOF---" || echo "FILE_NOT_FOUND: 2026-04-08.md"
cat /Users/guoshuyi/.openclaw/workspace/memory/2026-04-07.md 2>/dev/null && echo "---EOF---" || echo "FILE_NOT_FOUND: 2026-04-07.md"</exec>`;
const KIMI_FUNCTION_STYLE_TOOL_TEXT = `read({"file_path": "/Users/guoshuyi/.openclaw/workspace/SOUL.md"})
read({"file_path": "/Users/guoshuyi/.openclaw/workspace/USER.md"})
read({"file_path": "/Users/guoshuyi/.openclaw/workspace/memory/2026-04-08.md"})
read({"file_path": "/Users/guoshuyi/.openclaw/workspace/memory/2026-04-07.md"})
read({"file_path": "/Users/guoshuyi/.openclaw/workspace/MEMORY.md"})`;
const KIMI_MIXED_FUNCTION_STYLE_TOOL_TEXT = `I'll do my startup sequence now. Reading today's and yesterday's memory, plus confirming my core files. read(memory/2026-04-08.md) read(memory/2026-04-07.md) read(MEMORY.md) read(SOUL.md) read(USER.md)
Oops, let me do that properly with the tool. read({"file_path": "/Users/guoshuyi/.openclaw/workspace/memory/2026-04-08.md"}) read({"file_path": "/Users/guoshuyi/.openclaw/workspace/memory/2026-04-07.md"}) read({"file_path": "/Users/guoshuyi/.openclaw/workspace/MEMORY.md"}) read({"file_path": "/Users/guoshuyi/.openclaw/workspace/SOUL.md"}) read({"file_path": "/Users/guoshuyi/.openclaw/workspace/USER.md"})`;
const KIMI_PREFIX_FUNCTION_STYLE_TOOL_TEXT = `(read "/Users/guoshuyi/.openclaw/workspace/memory/2026-04-08.md")
(read "/Users/guoshuyi/.openclaw/workspace/memory/2026-04-07.md")
(read "/Users/guoshuyi/.openclaw/workspace/MEMORY.md")
(read "/Users/guoshuyi/.openclaw/workspace/SOUL.md")
(read "/Users/guoshuyi/.openclaw/workspace/USER.md")`;
const KIMI_JSON_TOOL_CALLS_TEXT = `I'll run my startup sequence now. Let me read the required files first.\`\`\`json
{"tool_calls": [{"id": "read_SOUL", "type": "read", "function": {"name": "read", "arguments": "{\\"file_path\\": \\"/Users/guoshuyi/.openclaw/workspace/SOUL.md\\"}"}}, {"id": "read_USER", "type": "read", "function": {"name": "read", "arguments": "{\\"file_path\\": \\"/Users/guoshuyi/.openclaw/workspace/USER.md\\"}"}}, {"id": "read_MEMORY", "type": "read", "function": {"name": "read", "arguments": "{\\"file_path\\": \\"/Users/guoshuyi/.openclaw/workspace/MEMORY.md\\"}"}}, {"id": "read_memory_today", "type": "read", "function": {"name": "read", "arguments": "{\\"file_path\\": \\"/Users/guoshuyi/.openclaw/workspace/memory/2026-04-08.md\\"}"}}, {"id": "read_memory_yesterday", "type": "read", "function": {"name": "read", "arguments": "{\\"file_path\\": \\"/Users/guoshuyi/.openclaw/workspace/memory/2026-04-07.md\\"}"}}]}]}
\`\`\``;

describe("kimi tool-call markup wrapper", () => {
  it("converts tagged Kimi tool-call text into structured tool calls", async () => {
    const partial = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_TOOL_TEXT }],
      stopReason: "stop",
    };
    const message = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_TOOL_TEXT }],
      stopReason: "stop",
    };
    const finalMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need to read the file first." },
        { type: "text", text: KIMI_TOOL_TEXT },
      ],
      stopReason: "stop",
    };

    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [{ type: "message_end", partial, message }],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    const result = (await stream.result()) as {
      content: unknown[];
      stopReason: string;
    };

    expect(events).toEqual([
      {
        type: "message_end",
        partial: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "functions.read:0",
              name: "functions.read",
              arguments: { file_path: "./package.json" },
            },
          ],
          stopReason: "toolUse",
        },
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "functions.read:0",
              name: "functions.read",
              arguments: { file_path: "./package.json" },
            },
          ],
          stopReason: "toolUse",
        },
      },
    ]);
    expect(result).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need to read the file first." },
        {
          type: "toolCall",
          id: "functions.read:0",
          name: "functions.read",
          arguments: { file_path: "./package.json" },
        },
      ],
      stopReason: "toolUse",
    });
  });

  it("leaves normal assistant text unchanged", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: "normal response" }],
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    await expect(stream.result()).resolves.toBe(finalMessage);
  });

  it("supports async stream functions", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_TOOL_TEXT }],
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = async () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = (await wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    )) as FakeStream;

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "functions.read:0",
          name: "functions.read",
          arguments: { file_path: "./package.json" },
        },
      ],
      stopReason: "toolUse",
    });
  });

  it("parses multiple tagged tool calls in one section", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_MULTI_TOOL_TEXT }],
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "functions.read:0",
          name: "functions.read",
          arguments: { file_path: "./package.json" },
        },
        {
          type: "toolCall",
          id: "functions.write:1",
          name: "functions.write",
          arguments: { file_path: "./out.txt", content: "done" },
        },
      ],
      stopReason: "toolUse",
    });
  });

  it("extracts XML function_calls blocks while preserving surrounding text", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_XML_TOOL_TEXT }],
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "I'll read the required memory files first. Let me check today's and yesterday's daily notes.\n\n",
        },
        {
          type: "toolCall",
          id: "read:0",
          name: "read",
          arguments: {
            path: "/Users/guoshuyi/.openclaw/workspace/memory/2026-04-08.md",
          },
        },
        {
          type: "toolCall",
          id: "read:1",
          name: "read",
          arguments: {
            path: "/Users/guoshuyi/.openclaw/workspace/memory/2026-04-07.md",
          },
        },
      ],
      stopReason: "toolUse",
    });
  });

  it("extracts downgraded exec tags while preserving surrounding text", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_EXEC_TOOL_TEXT }],
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Let me check the memory files for today and yesterday. I'll use the shell to read them since the read tool isn't available in this runtime.\n",
        },
        {
          type: "toolCall",
          id: "exec:0",
          name: "exec",
          arguments: {
            command: `cat /Users/guoshuyi/.openclaw/workspace/memory/2026-04-08.md 2>/dev/null && echo "---EOF---" || echo "FILE_NOT_FOUND: 2026-04-08.md"
cat /Users/guoshuyi/.openclaw/workspace/memory/2026-04-07.md 2>/dev/null && echo "---EOF---" || echo "FILE_NOT_FOUND: 2026-04-07.md"`,
          },
        },
      ],
      stopReason: "toolUse",
    });
  });

  it("extracts line-oriented function style tool calls", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_FUNCTION_STYLE_TOOL_TEXT }],
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "read:0",
          name: "read",
          arguments: { file_path: "/Users/guoshuyi/.openclaw/workspace/SOUL.md" },
        },
        {
          type: "toolCall",
          id: "read:1",
          name: "read",
          arguments: { file_path: "/Users/guoshuyi/.openclaw/workspace/USER.md" },
        },
        {
          type: "toolCall",
          id: "read:2",
          name: "read",
          arguments: { file_path: "/Users/guoshuyi/.openclaw/workspace/memory/2026-04-08.md" },
        },
        {
          type: "toolCall",
          id: "read:3",
          name: "read",
          arguments: { file_path: "/Users/guoshuyi/.openclaw/workspace/memory/2026-04-07.md" },
        },
        {
          type: "toolCall",
          id: "read:4",
          name: "read",
          arguments: { file_path: "/Users/guoshuyi/.openclaw/workspace/MEMORY.md" },
        },
      ],
      stopReason: "toolUse",
    });
  });

  it("extracts inline shorthand and JSON function style tool calls while preserving prose", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_MIXED_FUNCTION_STYLE_TOOL_TEXT }],
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "I'll do my startup sequence now. Reading today's and yesterday's memory, plus confirming my core files. ",
        },
        {
          type: "toolCall",
          id: "read:0",
          name: "read",
          arguments: { file_path: "memory/2026-04-08.md" },
        },
        {
          type: "toolCall",
          id: "read:1",
          name: "read",
          arguments: { file_path: "memory/2026-04-07.md" },
        },
        {
          type: "toolCall",
          id: "read:2",
          name: "read",
          arguments: { file_path: "MEMORY.md" },
        },
        {
          type: "toolCall",
          id: "read:3",
          name: "read",
          arguments: { file_path: "SOUL.md" },
        },
        {
          type: "toolCall",
          id: "read:4",
          name: "read",
          arguments: { file_path: "USER.md" },
        },
        {
          type: "text",
          text: "\nOops, let me do that properly with the tool. ",
        },
        {
          type: "toolCall",
          id: "read:5",
          name: "read",
          arguments: { file_path: "/Users/guoshuyi/.openclaw/workspace/memory/2026-04-08.md" },
        },
        {
          type: "toolCall",
          id: "read:6",
          name: "read",
          arguments: { file_path: "/Users/guoshuyi/.openclaw/workspace/memory/2026-04-07.md" },
        },
        {
          type: "toolCall",
          id: "read:7",
          name: "read",
          arguments: { file_path: "/Users/guoshuyi/.openclaw/workspace/MEMORY.md" },
        },
        {
          type: "toolCall",
          id: "read:8",
          name: "read",
          arguments: { file_path: "/Users/guoshuyi/.openclaw/workspace/SOUL.md" },
        },
        {
          type: "toolCall",
          id: "read:9",
          name: "read",
          arguments: { file_path: "/Users/guoshuyi/.openclaw/workspace/USER.md" },
        },
      ],
      stopReason: "toolUse",
    });
  });

  it("extracts prefix function style tool calls", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_PREFIX_FUNCTION_STYLE_TOOL_TEXT }],
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "read:0",
          name: "read",
          arguments: { file_path: "/Users/guoshuyi/.openclaw/workspace/memory/2026-04-08.md" },
        },
        {
          type: "toolCall",
          id: "read:1",
          name: "read",
          arguments: { file_path: "/Users/guoshuyi/.openclaw/workspace/memory/2026-04-07.md" },
        },
        {
          type: "toolCall",
          id: "read:2",
          name: "read",
          arguments: { file_path: "/Users/guoshuyi/.openclaw/workspace/MEMORY.md" },
        },
        {
          type: "toolCall",
          id: "read:3",
          name: "read",
          arguments: { file_path: "/Users/guoshuyi/.openclaw/workspace/SOUL.md" },
        },
        {
          type: "toolCall",
          id: "read:4",
          name: "read",
          arguments: { file_path: "/Users/guoshuyi/.openclaw/workspace/USER.md" },
        },
      ],
      stopReason: "toolUse",
    });
  });

  it("extracts fenced json tool_calls while preserving surrounding prose", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_JSON_TOOL_CALLS_TEXT }],
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "I'll run my startup sequence now. Let me read the required files first.",
        },
        {
          type: "toolCall",
          id: "read_SOUL",
          name: "read",
          arguments: { file_path: "/Users/guoshuyi/.openclaw/workspace/SOUL.md" },
        },
        {
          type: "toolCall",
          id: "read_USER",
          name: "read",
          arguments: { file_path: "/Users/guoshuyi/.openclaw/workspace/USER.md" },
        },
        {
          type: "toolCall",
          id: "read_MEMORY",
          name: "read",
          arguments: { file_path: "/Users/guoshuyi/.openclaw/workspace/MEMORY.md" },
        },
        {
          type: "toolCall",
          id: "read_memory_today",
          name: "read",
          arguments: { file_path: "/Users/guoshuyi/.openclaw/workspace/memory/2026-04-08.md" },
        },
        {
          type: "toolCall",
          id: "read_memory_yesterday",
          name: "read",
          arguments: { file_path: "/Users/guoshuyi/.openclaw/workspace/memory/2026-04-07.md" },
        },
      ],
      stopReason: "toolUse",
    });
  });

  it("adapts provider stream context without changing wrapper behavior", async () => {
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: KIMI_TOOL_TEXT }],
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = wrapKimiProviderStream({
      streamFn: baseStreamFn,
    } as never);
    const stream = wrapped(
      { api: "anthropic-messages", provider: "kimi", id: "k2p5" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "functions.read:0",
          name: "functions.read",
          arguments: { file_path: "./package.json" },
        },
      ],
      stopReason: "toolUse",
    });
  });

  it("keeps Kimi anthropic tool payloads native even if an upstream compat wrapper leaked in", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        tools: [
          {
            name: "read",
            description: "Read file",
            input_schema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
        tool_choice: { type: "tool", name: "read" },
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return createFakeStream({
        events: [],
        resultMessage: { role: "assistant", content: [], stopReason: "stop" },
      }) as ReturnType<StreamFn>;
    };

    const wrapped = wrapKimiProviderStream({
      streamFn: createAnthropicToolPayloadCompatibilityWrapper(baseStreamFn),
    } as never);
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "kimi",
        id: "k2p5",
        compat: {
          requiresOpenAiAnthropicToolPayload: true,
        },
      } as unknown as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(payloads).toEqual([
      {
        tools: [
          {
            name: "read",
            description: "Read file",
            input_schema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
        tool_choice: { type: "tool", name: "read" },
      },
    ]);
  });
});
