import { describe, expect, it, vi } from "vitest";
import { createCliJsonlStreamingParser, parseCliJson, parseCliJsonl } from "./cli-output.js";

describe("parseCliJson", () => {
  it("recovers mixed-output Claude session metadata from embedded JSON objects", () => {
    const result = parseCliJson(
      [
        "Claude Code starting...",
        '{"type":"init","session_id":"session-789"}',
        '{"type":"result","result":"Claude says hi","usage":{"input_tokens":9,"output_tokens":4}}',
      ].join("\n"),
      {
        command: "claude",
        output: "json",
        sessionIdFields: ["session_id"],
      },
    );

    expect(result).toEqual({
      text: "Claude says hi",
      sessionId: "session-789",
      usage: {
        input: 9,
        output: 4,
        cacheRead: undefined,
        cacheWrite: undefined,
        total: undefined,
      },
    });
  });

  it("parses Gemini CLI response text and stats payloads", () => {
    const result = parseCliJson(
      JSON.stringify({
        session_id: "gemini-session-123",
        response: "Gemini says hello",
        stats: {
          total_tokens: 21,
          input_tokens: 13,
          output_tokens: 5,
          cached: 8,
          input: 5,
        },
      }),
      {
        command: "gemini",
        output: "json",
        sessionIdFields: ["session_id"],
      },
    );

    expect(result).toEqual({
      text: "Gemini says hello",
      sessionId: "gemini-session-123",
      usage: {
        input: 5,
        output: 5,
        cacheRead: 8,
        cacheWrite: undefined,
        total: 21,
      },
    });
  });

  it("falls back to input_tokens minus cached when Gemini stats omit input", () => {
    const result = parseCliJson(
      JSON.stringify({
        session_id: "gemini-session-456",
        response: "Hello",
        stats: {
          total_tokens: 21,
          input_tokens: 13,
          output_tokens: 5,
          cached: 8,
        },
      }),
      {
        command: "gemini",
        output: "json",
        sessionIdFields: ["session_id"],
      },
    );

    expect(result?.usage?.input).toBe(5);
    expect(result?.usage?.cacheRead).toBe(8);
  });

  it("falls back to Gemini stats when usage exists without token fields", () => {
    const result = parseCliJson(
      JSON.stringify({
        session_id: "gemini-session-789",
        response: "Gemini says hello",
        usage: {},
        stats: {
          total_tokens: 21,
          input_tokens: 13,
          output_tokens: 5,
          cached: 8,
          input: 5,
        },
      }),
      {
        command: "gemini",
        output: "json",
        sessionIdFields: ["session_id"],
      },
    );

    expect(result).toEqual({
      text: "Gemini says hello",
      sessionId: "gemini-session-789",
      usage: {
        input: 5,
        output: 5,
        cacheRead: 8,
        cacheWrite: undefined,
        total: 21,
      },
    });
  });
});

describe("parseCliJsonl", () => {
  it("parses Claude stream-json result events", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-123" }),
        JSON.stringify({
          type: "result",
          session_id: "session-123",
          result: "Claude says hello",
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            cache_read_input_tokens: 4,
          },
        }),
      ].join("\n"),
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "Claude says hello",
      sessionId: "session-123",
      usage: {
        input: 12,
        output: 3,
        cacheRead: 4,
        cacheWrite: undefined,
        total: undefined,
      },
    });
  });

  it("preserves Claude session metadata even when the final result text is empty", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-456" }),
        JSON.stringify({
          type: "result",
          session_id: "session-456",
          result: "   ",
          usage: {
            input_tokens: 18,
            output_tokens: 0,
          },
        }),
      ].join("\n"),
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "",
      sessionId: "session-456",
      usage: {
        input: 18,
        output: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
        total: undefined,
      },
    });
  });

  it("parses multiple JSON objects embedded on the same line", () => {
    const result = parseCliJsonl(
      '{"type":"init","session_id":"session-999"} {"type":"result","session_id":"session-999","result":"done"}',
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "done",
      sessionId: "session-999",
      usage: undefined,
    });
  });
});

describe("createCliJsonlStreamingParser", () => {
  it("emits Claude Read tool calls from assistant message content blocks", () => {
    const onToolUse = vi.fn();
    const onSystemInit = vi.fn();
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onSystemInit,
      onAssistantDelta: vi.fn(),
      onToolUse,
    });

    parser.push(
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "session-123" }),
        JSON.stringify({
          type: "message",
          session_id: "session-123",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_function_1",
                name: "read",
                arguments: { path: "/tmp/session.claude-system-prompt.txt" },
              },
            ],
          },
        }),
      ].join("\n"),
    );
    parser.finish();

    expect(onToolUse).toHaveBeenCalledWith({
      name: "read",
      toolUseId: "call_function_1",
      input: { path: "/tmp/session.claude-system-prompt.txt" },
    });
    expect(onSystemInit).toHaveBeenCalledWith({
      subtype: "init",
      sessionId: "session-123",
    });
  });

  it("emits Claude thinking deltas and tool results", () => {
    const onThinkingDelta = vi.fn();
    const onToolResult = vi.fn();
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: vi.fn(),
      onThinkingDelta,
      onToolResult,
    });

    parser.push(
      [
        JSON.stringify({
          type: "stream_event",
          session_id: "session-321",
          event: {
            type: "content_block_delta",
            delta: {
              type: "thinking_delta",
              thinking: "Inspecting files",
            },
          },
        }),
        JSON.stringify({
          type: "user",
          session_id: "session-321",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_123",
                is_error: true,
                content: [{ type: "text", text: "Read failed" }],
              },
            ],
          },
        }),
      ].join("\n"),
    );
    parser.finish();

    expect(onThinkingDelta).toHaveBeenCalledWith({
      text: "Inspecting files",
      delta: "Inspecting files",
      sessionId: "session-321",
      usage: undefined,
    });
    expect(onToolResult).toHaveBeenCalledWith({
      toolUseId: "toolu_123",
      text: "Read failed",
      isError: true,
    });
  });

  it("emits Claude tool result line metadata when available", () => {
    const onToolResult = vi.fn();
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: vi.fn(),
      onToolResult,
    });

    parser.push(
      JSON.stringify({
        type: "user",
        session_id: "session-lines",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_lines",
              startLine: 1,
              numLines: 10,
              totalLines: 10,
              content: "full file",
            },
          ],
        },
      }),
    );
    parser.finish();

    expect(onToolResult).toHaveBeenCalledWith({
      toolUseId: "toolu_lines",
      text: "full file",
      startLine: 1,
      numLines: 10,
      totalLines: 10,
    });
  });

  it("deduplicates repeated Claude records from mixed stdout replay", () => {
    const onAssistantDelta = vi.fn();
    const onToolUse = vi.fn();
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta,
      onToolUse,
    });

    const line = JSON.stringify({
      type: "stream_event",
      session_id: "session-dup",
      event: {
        type: "content_block_start",
        content_block: {
          type: "tool_use",
          id: "toolu_dup",
          name: "Read",
          input: { file_path: "/tmp/test.txt" },
        },
      },
    });

    parser.push(`${line}\n`);
    parser.push(`${line}\n`);
    parser.finish();

    expect(onToolUse).toHaveBeenCalledTimes(1);
    expect(onAssistantDelta).not.toHaveBeenCalled();
  });

  it("re-emits tool use when later Claude records fill in the tool input", () => {
    const onToolUse = vi.fn();
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: vi.fn(),
      onToolUse,
    });

    parser.push(
      [
        JSON.stringify({
          type: "stream_event",
          session_id: "session-rich",
          event: {
            type: "content_block_start",
            content_block: {
              type: "tool_use",
              id: "toolu_rich",
              name: "Read",
              input: {},
            },
          },
        }),
        JSON.stringify({
          type: "assistant",
          session_id: "session-rich",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_rich",
                name: "Read",
                input: { file_path: "/tmp/prompt.txt", limit: 200 },
              },
            ],
          },
        }),
      ].join("\n"),
    );
    parser.finish();

    expect(onToolUse).toHaveBeenCalledTimes(2);
    expect(onToolUse.mock.calls[0]?.[0]).toEqual({
      name: "Read",
      toolUseId: "toolu_rich",
      input: {},
    });
    expect(onToolUse.mock.calls[1]?.[0]).toEqual({
      name: "Read",
      toolUseId: "toolu_rich",
      input: { file_path: "/tmp/prompt.txt", limit: 200 },
    });
  });
});
