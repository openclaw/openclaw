import { describe, expect, it } from "vitest";
import { parseCliJson, parseCliJsonl } from "./cli-output.js";

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

  it("preserves Claude cache creation tokens instead of flattening them to zero", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-cache-123" }),
        JSON.stringify({
          type: "result",
          session_id: "session-cache-123",
          result: "Claude says hello",
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 7,
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
      sessionId: "session-cache-123",
      usage: {
        input: 12,
        output: 3,
        cacheRead: 4,
        cacheWrite: 7,
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
