import { describe, expect, it } from "vitest";
import {
  shouldRepairMalformedToolCallArguments,
  wrapStreamFnRepairMalformedToolCallArguments,
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
}): Promise<ToolCallRepairCaseResult> {
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
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: `.functions.${toolName}:0 `,
            partial: partialMessage,
          },
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

  for await (const item of stream) {
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
        provider: "openai-codex",
        modelApi: "openai-codex-responses",
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
  it.each([
    ["openai-completions", "sglang"],
    ["openai-codex-responses", "openai-codex"],
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

      for await (const item of stream) {
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
