// Coverage for repairing malformed streamed tool-call arguments.
import { describe, expect, it } from "vitest";
import { wrapStreamFnTextTransforms } from "../../plugin-text-transforms.js";
import {
  shouldRepairMalformedToolCallArguments,
  wrapStreamFnRepairMalformedToolCallArguments,
  wrapStreamResultRepairDoubleEscapedCodeStrings,
} from "./attempt.tool-call-argument-repair.js";

type FakeWrappedStream = {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

type FakeStreamFn = (
  model: never,
  context: never,
  options: never,
) => FakeWrappedStream | Promise<FakeWrappedStream>;

function createFakeStream(params: {
  events: unknown[];
  resultMessage: unknown;
}): FakeWrappedStream {
  // Minimal fake stream lets repair tests assert both streamed events and final
  // result mutation.
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

async function invokeProviderStream(params: {
  provider: string;
  modelApi: string;
  baseFn: FakeStreamFn;
}): Promise<FakeWrappedStream> {
  // Repair is provider/API gated; this helper mirrors the production wrapper
  // selection before invoking the fake stream.
  const streamFn = shouldRepairMalformedToolCallArguments({
    provider: params.provider,
    modelApi: params.modelApi,
  })
    ? (wrapStreamFnRepairMalformedToolCallArguments(params.baseFn as never) as FakeStreamFn)
    : params.baseFn;
  return await Promise.resolve(streamFn({} as never, {} as never, {} as never));
}

type ToolCallRepairCaseResult = {
  partialArgs: unknown;
  streamedArgs: unknown;
  endMessageArgs: unknown;
  finalArgs: unknown;
  result: unknown;
  finalMessage: unknown;
};

async function runToolCallRepairCase(params: {
  toolName?: string;
  delta: string;
  provider?: string;
  modelApi?: string;
  includePreamble?: boolean;
  preambleToolName?: string;
}): Promise<ToolCallRepairCaseResult> {
  // One case tracks every representation of the tool call so repairs stay
  // synchronized across partial, end, and final messages.
  const toolName = params.toolName ?? "write";
  const partialToolCall = { type: "functionCall", name: toolName, arguments: {} };
  const streamedToolCall = { type: "functionCall", name: toolName, arguments: {} };
  const endMessageToolCall = { type: "functionCall", name: toolName, arguments: {} };
  const finalToolCall = { type: "functionCall", name: toolName, arguments: {} };
  const partialMessage = { role: "assistant", content: [partialToolCall] };
  const endMessage = { role: "assistant", content: [endMessageToolCall] };
  const finalMessage = { role: "assistant", content: [finalToolCall] };

  const stream = await invokeProviderStream({
    provider: params.provider ?? "openai-compatible",
    modelApi: params.modelApi ?? "openai-completions",
    baseFn: () =>
      createFakeStream({
        events: [
          ...(params.includePreamble === false
            ? []
            : [
                {
                  type: "toolcall_delta",
                  contentIndex: 0,
                  delta: `.functions.${params.preambleToolName ?? toolName}:0 `,
                  partial: partialMessage,
                },
              ]),
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: params.delta,
            partial: partialMessage,
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedToolCall,
            partial: partialMessage,
            message: endMessage,
          },
        ],
        resultMessage: finalMessage,
      }),
  });

  for await (const ignoredItem of stream) {
    void ignoredItem;
    // drain
  }
  const result = await stream.result();

  return {
    partialArgs: partialToolCall.arguments,
    streamedArgs: streamedToolCall.arguments,
    endMessageArgs: endMessageToolCall.arguments,
    finalArgs: finalToolCall.arguments,
    result,
    finalMessage,
  };
}

function expectAllToolCallArgs(
  result: ToolCallRepairCaseResult,
  expectedArgs: Record<string, unknown>,
): void {
  expect(result.partialArgs).toEqual(expectedArgs);
  expect(result.streamedArgs).toEqual(expectedArgs);
  expect(result.endMessageArgs).toEqual(expectedArgs);
  expect(result.finalArgs).toEqual(expectedArgs);
  expect(result.result).toBe(result.finalMessage);
}

describe("shouldRepairMalformedToolCallArguments", () => {
  it("keeps the repair enabled for kimi providers on anthropic-messages", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "kimi",
        modelApi: "anthropic-messages",
      }),
    ).toBe(true);
  });

  it("does not apply kimi repair across provider id variants", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "kimi-coding",
        modelApi: "anthropic-messages",
      }),
    ).toBe(false);
  });

  it("enables the repair for openai-completions even when the provider is not kimi", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "openai-compatible",
        modelApi: "openai-completions",
      }),
    ).toBe(true);
  });

  it("does not enable the repair for unrelated non-kimi transports", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "openai-compatible",
        modelApi: "openai-responses",
      }),
    ).toBe(false);
  });

  it("keeps kimi providers off on non-anthropic non-openai-completions transports", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "kimi-coding",
        modelApi: "openai-responses",
      }),
    ).toBe(false);
  });

  it("does not enable the repair for direct OpenAI responses", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "openai",
        modelApi: "openai-responses",
      }),
    ).toBe(false);
  });

  it("enables the repair for Codex and Azure Responses transports", () => {
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "openai",
        modelApi: "openai-chatgpt-responses",
      }),
    ).toBe(true);
    expect(
      shouldRepairMalformedToolCallArguments({
        provider: "azure-openai-responses",
        modelApi: "azure-openai-responses",
      }),
    ).toBe(true);
  });
});

describe("openai-completions malformed tool-call argument repair", () => {
  it("restores split replacement tokens after argument repair", async () => {
    const partialToolCall = { type: "toolCall", name: "send", arguments: {} };
    const streamedToolCall = { type: "toolCall", name: "send", arguments: {} };
    const finalToolCall = { type: "toolCall", name: "send", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn: FakeStreamFn = () =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"text":"[MAS',
            partial: partialMessage,
          },
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: 'KED]"}',
            partial: partialMessage,
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedToolCall,
            partial: partialMessage,
          },
        ],
        resultMessage: finalMessage,
      });
    const repairedFn = wrapStreamFnRepairMalformedToolCallArguments(baseFn as never);
    const transformedFn = wrapStreamFnTextTransforms({
      streamFn: repairedFn,
      output: [{ from: /\[MASKED\]/g, to: "John Smith" }],
    }) as FakeStreamFn;
    const stream = await Promise.resolve(transformedFn({} as never, {} as never, {} as never));
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(
      events
        .filter((event) => (event as { type?: string }).type === "toolcall_delta")
        .map((event) => (event as { delta?: string }).delta),
    ).toEqual(['{"text":"[MAS', 'KED]"}']);
    const endEvent = events.find(
      (event) => (event as { type?: string }).type === "toolcall_end",
    ) as { toolCall?: { arguments?: unknown } } | undefined;
    expect(endEvent?.toolCall?.arguments).toEqual({ text: "John Smith" });
    await expect(stream.result()).resolves.toMatchObject({
      content: [{ arguments: { text: "John Smith" } }],
    });
  });

  it.each([
    ["openai-completions", "sglang"],
    ["openai-chatgpt-responses", "openai"],
    ["azure-openai-responses", "azure-openai-responses"],
  ])(
    "repairs fragmented %s function-call args before tool execution",
    async (modelApi, provider) => {
      const partialToolCall = { type: "functionCall", name: "read", arguments: {} };
      const streamedToolCall = { type: "functionCall", name: "read", arguments: {} };
      const endMessageToolCall = { type: "functionCall", name: "read", arguments: {} };
      const finalToolCall = { type: "functionCall", name: "read", arguments: {} };
      const partialMessage = { role: "assistant", content: [partialToolCall] };
      const endMessage = { role: "assistant", content: [endMessageToolCall] };
      const finalMessage = { role: "assistant", content: [finalToolCall] };

      const stream = await invokeProviderStream({
        provider,
        modelApi,
        baseFn: () =>
          createFakeStream({
            events: [
              {
                type: "toolcall_delta",
                contentIndex: 0,
                delta: ".functions.read:0 ",
                partial: partialMessage,
              },
              {
                type: "toolcall_delta",
                contentIndex: 0,
                delta: '{"path":"/tmp/report.txt"',
                partial: partialMessage,
              },
              {
                type: "toolcall_delta",
                contentIndex: 0,
                delta: "}x",
                partial: partialMessage,
              },
              {
                type: "toolcall_end",
                contentIndex: 0,
                toolCall: streamedToolCall,
                partial: partialMessage,
                message: endMessage,
              },
            ],
            resultMessage: finalMessage,
          }),
      });

      for await (const ignoredItem of stream) {
        void ignoredItem;
        // drain
      }
      const result = await stream.result();

      expect(partialToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
      expect(streamedToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
      expect(endMessageToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
      expect(finalToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
      expect(result).toBe(finalMessage);
    },
  );

  it("repairs smart-quoted edit args with CJK, markdown, and inner smart quotes", async () => {
    const expectedContent =
      '更新 **草稿** with “smart”, “sure” and code "x"\nJSON-ish “alpha”, “path”: “ignored” snippet\nSee [“quoted”](https://example.test)\nconst re = /\\d+/;\n内部内容';
    const result = await runToolCallRepairCase({
      toolName: "edit",
      delta: String.raw` {“path”:“notes/报告.md”,“oldText”:“旧的 **草稿**”,“newText”:“更新 **草稿** with “smart”, “sure” and code "x"
JSON-ish “alpha”, “path”: “ignored” snippet
See [“quoted”](https://example.test)
const re = /\d+/;
内部内容”}`,
    });

    expectAllToolCallArgs(result, {
      path: "notes/报告.md",
      oldText: "旧的 **草稿**",
      newText: expectedContent,
    });
  });

  it("repairs smart-quoted edit args that use the current edits array schema", async () => {
    const result = await runToolCallRepairCase({
      toolName: "edit",
      delta: String.raw` {“path”:“notes/报告.md”,“edits”:[{“oldText”:“旧的 **草稿**”,“newText”:“更新 \"草稿\"\nnext”},{“oldText”:“tail”,“newText”:“done”}]}`,
    });

    expectAllToolCallArgs(result, {
      path: "notes/报告.md",
      edits: [
        { oldText: "旧的 **草稿**", newText: '更新 "草稿"\nnext' },
        { oldText: "tail", newText: "done" },
      ],
    });
  });

  it("preserves smart quotes inside ASCII-delimited JSON content with trailing junk", async () => {
    const result = await runToolCallRepairCase({
      toolName: "read",
      delta: '{"path":"notes/日志.md","content":"包含“内部”与 **重点** 字样"}x',
    });

    expectAllToolCallArgs(result, {
      path: "notes/日志.md",
      content: "包含“内部”与 **重点** 字样",
    });
  });

  it("repairs smart-quoted command args that use workdir", async () => {
    const result = await runToolCallRepairCase({
      toolName: "exec",
      delta: "{“command“:“pwd“,“workdir“:“/tmp“}",
    });

    expectAllToolCallArgs(result, { command: "pwd", workdir: "/tmp" });
  });

  it("repairs an exact smart-quoted argument object without preamble or trailing junk", async () => {
    const result = await runToolCallRepairCase({
      toolName: "read",
      delta: "{“path”:“safe.txt”}",
    });

    expectAllToolCallArgs(result, { path: "safe.txt" });
  });

  it("repairs smart-quoted non-freeform args before schema-specific option keys", async () => {
    const result = await runToolCallRepairCase({
      toolName: "read",
      delta: "{“path”:“safe.txt”,“offset”:5,“limit”:20}",
    });

    expectAllToolCallArgs(result, { path: "safe.txt", offset: 5, limit: 20 });
  });

  it("repairs prefixless smart-quoted read args before schema-specific option keys", async () => {
    const result = await runToolCallRepairCase({
      toolName: "read",
      delta: "{“path”:“safe.txt”,“offset”:5,“limit”:20}",
      includePreamble: false,
    });

    expectAllToolCallArgs(result, { path: "safe.txt", offset: 5, limit: 20 });
  });

  it("repairs smart-quoted read args with a case-varied structured tool name", async () => {
    const result = await runToolCallRepairCase({
      toolName: "Read",
      delta: "{“path”:“safe.txt”,“offset”:5,“limit”:20}",
      includePreamble: false,
    });

    expectAllToolCallArgs(result, { path: "safe.txt", offset: 5, limit: 20 });
  });

  it("keeps unknown member-looking prose inside smart-quoted non-freeform args", async () => {
    const result = await runToolCallRepairCase({
      toolName: "grep",
      delta: String.raw` {“pattern”:“Use ”, “foo”: “bar” in prose”,“path”:“safe.txt”}`,
    });

    expectAllToolCallArgs(result, {
      pattern: "Use ”, “foo”: “bar” in prose",
      path: "safe.txt",
    });
    expect(result.finalArgs).not.toHaveProperty("foo");
  });

  it("keeps known option-looking prose inside unrelated smart-quoted args", async () => {
    const result = await runToolCallRepairCase({
      toolName: "grep",
      delta: String.raw` {“pattern”:“Use ”, “limit”: “bar” in prose”,“path”:“safe.txt”}`,
    });

    expectAllToolCallArgs(result, {
      pattern: "Use ”, “limit”: “bar” in prose",
      path: "safe.txt",
    });
    expect(result.finalArgs).not.toHaveProperty("limit");
  });

  it("uses the structured tool name over a mismatched smart-quote repair prefix", async () => {
    const result = await runToolCallRepairCase({
      toolName: "grep",
      preambleToolName: "read",
      delta: String.raw` {“pattern”:“Use ”, “limit”: “bar” in prose”,“path”:“safe.txt”}`,
    });

    expectAllToolCallArgs(result, {
      pattern: "Use ”, “limit”: “bar” in prose",
      path: "safe.txt",
    });
    expect(result.finalArgs).not.toHaveProperty("limit");
  });

  it("ignores inherited tool-name successor lookups while repairing smart-quoted args", async () => {
    const result = await runToolCallRepairCase({
      toolName: "constructor",
      delta: "{“length”:“x”,“foo”:1}",
    });

    expectAllToolCallArgs(result, {});
  });

  it("decodes JSON escapes inside smart-quoted string args", async () => {
    const result = await runToolCallRepairCase({
      delta: String.raw` {“path”:“safe.txt”,“content”:“line\nnext \"quoted\" path C:\\tmp mark \u2713 invalid \d”}`,
    });

    expectAllToolCallArgs(result, {
      path: "safe.txt",
      content: 'line\nnext "quoted" path C:\\tmp mark ✓ invalid \\d',
    });
  });

  it("keeps duplicate-looking smart-quoted args inside content", async () => {
    const result = await runToolCallRepairCase({
      delta: String.raw` {“path”:“safe.txt”,“content”:“text ”, “path”: “other.txt””}`,
    });

    expectAllToolCallArgs(result, {
      path: "safe.txt",
      content: "text ”, “path”: “other.txt”",
    });
  });

  it("keeps unknown member-looking prose inside smart-quoted content", async () => {
    const result = await runToolCallRepairCase({
      delta: String.raw` {“path”:“safe.txt”,“content”:“Use ”, “foo”: “bar” in prose”}`,
    });

    expectAllToolCallArgs(result, {
      path: "safe.txt",
      content: "Use ”, “foo”: “bar” in prose",
    });
    expect(result.finalArgs).not.toHaveProperty("foo");
  });

  it("keeps member-looking prose inside mixed ASCII-key smart-quoted content", async () => {
    const result = await runToolCallRepairCase({
      delta: String.raw` {"path":"safe.txt","content":“Use ”, “foo”: “bar” in prose”}`,
    });

    expectAllToolCallArgs(result, {
      path: "safe.txt",
      content: "Use ”, “foo”: “bar” in prose",
    });
    expect(result.finalArgs).not.toHaveProperty("foo");
  });
});

describe("wrapStreamResultRepairDoubleEscapedCodeStrings", () => {
  it("repairs double-escaped \\n at colon-then-indent Python block boundaries", async () => {
    const baseFn: FakeStreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: {
          content: [
            {
              type: "toolCall",
              id: "tc-1",
              name: "write",
              arguments: {
                path: "test.py",
                content: "class Foo:\\n    def bar():\\n        pass",
              },
            },
          ],
        },
      });

    const wrapped = wrapStreamResultRepairDoubleEscapedCodeStrings(baseFn as never);
    const stream = await Promise.resolve(wrapped({} as never, {} as never, {} as never));
    const message = (await stream.result()) as {
      content: Array<{ arguments?: { content?: string } }>;
    };

    const args = message.content[0]?.arguments;
    expect(args?.content).toContain("\n");
    expect(args?.content).not.toContain("\\n");
    expect(args?.content).toBe("class Foo:\n    def bar():\n        pass");
  });

  it("repairs double-escaped \\n in exec command arguments", async () => {
    const baseFn: FakeStreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: {
          content: [
            {
              type: "toolCall",
              id: "tc-1",
              name: "exec",
              arguments: {
                command: 'python -c "for i in range(3):\\n    print(i)"',
              },
            },
          ],
        },
      });

    const wrapped = wrapStreamResultRepairDoubleEscapedCodeStrings(baseFn as never);
    const stream = await Promise.resolve(wrapped({} as never, {} as never, {} as never));
    const message = (await stream.result()) as {
      content: Array<{ arguments?: { command?: string } }>;
    };

    const args = message.content[0]?.arguments;
    expect(args?.command).toContain("\n");
    expect(args?.command).not.toContain("\\n");
  });

  it("preserves intentional literal \\n escapes in string literals", async () => {
    // Mixed: corrupted \n at code boundaries + intentional \n in a regex string
    const baseFn: FakeStreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: {
          content: [
            {
              type: "toolCall",
              id: "tc-1",
              name: "write",
              arguments: {
                path: "test.py",
                content:
                  'import re\n\nclass Parser:\n    def tokenize(self, text):\n        return re.split(r"\\n", text)',
              },
            },
          ],
        },
      });

    const wrapped = wrapStreamResultRepairDoubleEscapedCodeStrings(baseFn as never);
    const stream = await Promise.resolve(wrapped({} as never, {} as never, {} as never));
    const message = (await stream.result()) as {
      content: Array<{ arguments?: { content?: string } }>;
    };

    const args = message.content[0]?.arguments;
    // Code-structure \n at block boundaries were repaired to real newlines
    expect(args?.content).toContain("class Parser:\n    def tokenize");
    // Intentional \n in the regex string literal is preserved byte-for-byte
    expect(args?.content).toContain('r"\\n"');
  });

  it("does not modify non-code keys like path or pattern", async () => {
    const baseFn: FakeStreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: {
          content: [
            {
              type: "toolCall",
              id: "tc-1",
              name: "write",
              arguments: {
                path: "test\\nfile.py",
                content: "class Foo:\\n    pass",
              },
            },
          ],
        },
      });

    const wrapped = wrapStreamResultRepairDoubleEscapedCodeStrings(baseFn as never);
    const stream = await Promise.resolve(wrapped({} as never, {} as never, {} as never));
    const message = (await stream.result()) as {
      content: Array<{ arguments?: { path?: string; content?: string } }>;
    };

    const args = message.content[0]?.arguments;
    // path is not a code-like key — literal \n preserved
    expect(args?.path).toBe("test\\nfile.py");
    // content is a code-like key — \n repaired
    expect(args?.content).toBe("class Foo:\n    pass");
  });

  it("repairs consecutive \\n\\t structural indentation in code blocks", async () => {
    // Models may output \n\t (literal newline + literal tab) for indented
    // Python blocks. Both escapes must be repaired.
    const baseFn: FakeStreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: {
          content: [
            {
              type: "toolCall",
              id: "tc-1",
              name: "write",
              arguments: {
                path: "test.py",
                content: "class Foo:\\n\\tdef bar():\\n\\t\\tpass\\n\\ndef baz():\\n\\treturn 42",
              },
            },
          ],
        },
      });

    const wrapped = wrapStreamResultRepairDoubleEscapedCodeStrings(baseFn as never);
    const stream = await Promise.resolve(wrapped({} as never, {} as never, {} as never));
    const message = (await stream.result()) as {
      content: Array<{ arguments?: { content?: string } }>;
    };

    const content = message.content[0]?.arguments?.content;
    // \n\t should become real newline + real tab
    expect(content).toContain("\n\tdef bar()");
    expect(content).toContain("\n\t\tpass");
    // \n\t and \n\t\t at block boundaries repaired to real newline+tab
    expect(content).toContain("\n\tdef bar()");
    expect(content).toContain("\n\t\tpass");
    // No literal \t remaining (tabs were inside block indentation)
    expect(content).not.toContain("\\t");
  });

  it("exposes repaired arguments on the final tool call result", async () => {
    // The stream result must carry the repaired arguments so tool
    // execution sees corrected values. Uses the result() path directly
    // (the same path the production wrapper uses for all providers).
    const baseFn: FakeStreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: {
          content: [
            {
              type: "toolCall",
              id: "tc-1",
              name: "write",
              arguments: {
                path: "test.py",
                content: "class Foo:\\n    def bar():\\n        pass",
              },
            },
          ],
        },
      });

    const wrapped = wrapStreamResultRepairDoubleEscapedCodeStrings(baseFn as never);
    const stream = await Promise.resolve(wrapped({} as never, {} as never, {} as never));
    const message = (await stream.result()) as {
      content: Array<{ arguments?: { content?: string } }>;
    };

    const args = message.content[0]?.arguments;
    expect(args?.content).toContain("\n");
    expect(args?.content).not.toContain("\\n");
    expect(args?.content).toBe("class Foo:\n    def bar():\n        pass");
  });

  it("preserves intentional colon-followed literal \\n in exec.command byte-for-byte", async () => {
    // An exec command that contains a colon followed by a real newline
    // (correctly escaped in JSON as \n) must not be modified. The colon
    // here is inside a string literal, not Python block syntax.
    const baseFn: FakeStreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: {
          content: [
            {
              type: "toolCall",
              id: "tc-1",
              name: "exec",
              arguments: {
                command: 'python -c "for i in range(3):\n    print(i)"',
              },
            },
          ],
        },
      });

    const wrapped = wrapStreamResultRepairDoubleEscapedCodeStrings(baseFn as never);
    const stream = await Promise.resolve(wrapped({} as never, {} as never, {} as never));
    const message = (await stream.result()) as {
      content: Array<{ arguments?: { command?: string } }>;
    };

    const args = message.content[0]?.arguments;
    // The command has a real newline (from JSON \n), NOT literal \n.
    // It must pass through unchanged — the colon is inside a string
    // literal, not at a Python block boundary.
    expect(args?.command).toContain("\n");
    expect(args?.command).not.toContain("\\n");
    expect(args?.command).toContain('python -c "for i in range(3):');
  });

  it("preserves intentional literal \\n in exec.command when not an indented code block", async () => {
    // A shell command with an intentional literal \n (correctly
    // JSON-encoded as \\n, producing two chars backslash+n after
    // parse). The colon precedes the \n but the \n is not followed
    // by indentation — this is NOT a Python code block. The
    // constrained fingerprint must not trigger, leaving the value
    // byte-for-byte unchanged.
    const baseFn: FakeStreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: {
          content: [
            {
              type: "toolCall",
              id: "tc-1",
              name: "exec",
              arguments: {
                command: "echo 'end:\\n' > /dev/null",
              },
            },
          ],
        },
      });

    const wrapped = wrapStreamResultRepairDoubleEscapedCodeStrings(baseFn as never);
    const stream = await Promise.resolve(wrapped({} as never, {} as never, {} as never));
    const message = (await stream.result()) as {
      content: Array<{ arguments?: { command?: string } }>;
    };

    const args = message.content[0]?.arguments;
    // The literal \n after the colon is followed by a closing quote,
    // not by whitespace indentation. It must remain as literal \n.
    expect(args?.command).toContain("\\n");
    expect(args?.command).not.toContain("\n");
    expect(args?.command).toBe("echo 'end:\\n' > /dev/null");
  });

  it("preserves intentional literal \\n inside a Python string literal in content", async () => {
    // A Python source file containing a string literal with an
    // intentional \n (two literal chars backslash+n) at a colon
    // position WITH indentation. This is NOT a double-escaped code
    // block — the \n is inside matching quotes (a Python string).
    // The repair must leave it byte-for-byte unchanged.
    const baseFn: FakeStreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: {
          content: [
            {
              type: "toolCall",
              id: "tc-1",
              name: "write",
              arguments: {
                path: "demo.py",
                content:
                  'import sys\n\nclass Demo:\n    def run(self):\n        msg = "Usage:\\n    python demo.py --help"\n        print(msg)',
              },
            },
          ],
        },
      });

    const wrapped = wrapStreamResultRepairDoubleEscapedCodeStrings(baseFn as never);
    const stream = await Promise.resolve(wrapped({} as never, {} as never, {} as never));
    const message = (await stream.result()) as {
      content: Array<{ arguments?: { content?: string } }>;
    };

    const args = message.content[0]?.arguments;
    // Structural \n at class:def boundary is repaired
    expect(args?.content).toContain("class Demo:\n    def run");
    // Intentional \n inside the string literal is preserved
    expect(args?.content).toContain('"Usage:\\n    python demo.py --help"');
    // No real newline inside the string literal
    expect(args?.content).not.toContain('"Usage:\n    python demo.py --help"');
  });

  it("preserves intentional literal \\n inside a string in exec.command", async () => {
    // An exec command with an intentional literal \n inside shell
    // quotes — correctly JSON-encoded as \\n, producing literal
    // backslash+n after parse. The \n is after a colon and has
    // indentation, but it's inside matching double quotes. The
    // repair must leave it byte-for-byte unchanged.
    const baseFn: FakeStreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: {
          content: [
            {
              type: "toolCall",
              id: "tc-1",
              name: "exec",
              arguments: {
                command: 'printf "Usage:\\n    %s [opts]\\n" "$0" > /tmp/help.txt',
              },
            },
          ],
        },
      });

    const wrapped = wrapStreamResultRepairDoubleEscapedCodeStrings(baseFn as never);
    const stream = await Promise.resolve(wrapped({} as never, {} as never, {} as never));
    const message = (await stream.result()) as {
      content: Array<{ arguments?: { command?: string } }>;
    };

    const args = message.content[0]?.arguments;
    // The literal \n inside the printf format string is intentional
    // and must be preserved byte-for-byte.
    expect(args?.command).toContain("\\n");
    // No real newline introduced into the format string
    expect(args?.command).toBe('printf "Usage:\\n    %s [opts]\\n" "$0" > /tmp/help.txt');
  });
});
