import { describe, expect, it } from "vitest";
import {
  createCliJsonlStreamingParser,
  extractClaudeCliRateLimitStatus,
  extractCliErrorMessage,
  parseCliJson,
  parseCliJsonl,
} from "./cli-output.js";
import { createClaudeApiErrorFixture } from "./test-helpers/claude-api-error-fixture.js";

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

  it("unwraps nested Claude result JSON from JSON output", () => {
    const result = parseCliJson(
      JSON.stringify({
        session_id: "session-nested-json",
        result: JSON.stringify({
          type: "result",
          result: JSON.stringify({
            type: "result",
            subtype: "success",
            result: "actual response text",
          }),
        }),
      }),
      {
        command: "claude",
        output: "json",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      text: "actual response text",
      sessionId: "session-nested-json",
      usage: undefined,
    });
  });

  it("does not unwrap nested result-shaped JSON for non-claude json backends", () => {
    const nestedResult = JSON.stringify({
      type: "result",
      result: JSON.stringify({
        type: "result",
        result: "actual response text",
      }),
    });
    const result = parseCliJson(
      JSON.stringify({
        session_id: "gemini-session-nested-json",
        result: nestedResult,
      }),
      {
        command: "gemini",
        output: "json",
        sessionIdFields: ["session_id"],
      },
      "gemini",
    );

    expect(result).toEqual({
      text: nestedResult,
      sessionId: "gemini-session-nested-json",
      usage: undefined,
    });
  });

  it("parses nested OpenAI-style cached token details from CLI json payloads", () => {
    const result = parseCliJson(
      JSON.stringify({
        session_id: "openai-session-123",
        response: "OpenAI says hello",
        usage: {
          input_tokens: 15,
          output_tokens: 4,
          input_tokens_details: {
            cached_tokens: 6,
          },
        },
      }),
      {
        command: "codex",
        output: "json",
        sessionIdFields: ["session_id"],
      },
    );

    expect(result).toEqual({
      text: "OpenAI says hello",
      sessionId: "openai-session-123",
      usage: {
        input: 9,
        output: 4,
        cacheRead: 6,
        cacheWrite: undefined,
        total: undefined,
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

  it("parses Claude stream-json result events for an explicit backend dialect", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-dialect" }),
        JSON.stringify({
          type: "result",
          session_id: "session-dialect",
          result: "dialect says hello",
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
      ].join("\n"),
      {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      "local-cli",
    );

    expect(result).toEqual({
      text: "dialect says hello",
      sessionId: "session-dialect",
      usage: {
        input: 5,
        output: 2,
        cacheRead: undefined,
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

  it("unwraps nested Claude agent result JSON from stream-json output", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ type: "init", session_id: "session-nested-jsonl" }),
        JSON.stringify({
          type: "result",
          session_id: "session-nested-jsonl",
          result: JSON.stringify({
            type: "result",
            result: JSON.stringify({
              type: "result",
              subtype: "success",
              result: "actual response text",
            }),
          }),
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
      text: "actual response text",
      sessionId: "session-nested-jsonl",
      usage: undefined,
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

  it("extracts nested Claude API errors from failed stream-json output", () => {
    const { message, jsonl } = createClaudeApiErrorFixture();
    const result = extractCliErrorMessage(jsonl);

    expect(result).toBe(message);
  });
});

describe("createCliJsonlStreamingParser", () => {
  it("streams Claude stream-json deltas for an explicit backend dialect", () => {
    const deltas: Array<{ text: string; delta: string; sessionId?: string }> = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "local-cli",
      onAssistantDelta: (delta) => deltas.push(delta),
    });

    parser.push(
      [
        JSON.stringify({ type: "init", session_id: "session-stream" }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "hello" },
          },
        }),
      ].join("\n"),
    );
    parser.finish();

    expect(deltas).toEqual([
      { text: "hello", delta: "hello", sessionId: "session-stream", usage: undefined },
    ]);
  });
});

const RATE_LIMIT_EVENT_BACKEND = {
  command: "claude",
  output: "jsonl" as const,
  sessionIdFields: ["session_id"],
};

function buildRateLimitEventJsonl(status: string, rateLimitType = "seven_day"): string {
  return JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: {
      rateLimitType,
      utilization: 0.87,
      status,
      surpassedThreshold: 0.75,
      isUsingOverage: false,
      resetsAt: 1778835600,
    },
  });
}

describe("rate_limit_event — Claude CLI JSONL", () => {
  describe("extractClaudeCliRateLimitStatus", () => {
    it("returns status from a rate_limit_event record", () => {
      const parsed = JSON.parse(buildRateLimitEventJsonl("allowed_warning")) as Record<
        string,
        unknown
      >;
      expect(extractClaudeCliRateLimitStatus(parsed)).toBe("allowed_warning");
    });

    it("returns null for non-rate_limit_event records", () => {
      expect(extractClaudeCliRateLimitStatus({ type: "result", result: "hello" })).toBeNull();
    });

    it("returns null when rate_limit_info is missing", () => {
      expect(extractClaudeCliRateLimitStatus({ type: "rate_limit_event" })).toBeNull();
    });
  });

  describe("extractCliErrorMessage — rate_limit_event pass-through", () => {
    it("returns null for allowed_warning (request was served)", () => {
      const jsonl = [
        buildRateLimitEventJsonl("allowed_warning"),
        JSON.stringify({
          type: "result",
          session_id: "session-rl",
          result: "Hello!",
          is_error: false,
        }),
      ].join("\n");

      expect(extractCliErrorMessage(jsonl)).toBeNull();
    });

    it("returns null for allowed (request was served)", () => {
      const jsonl = [
        buildRateLimitEventJsonl("allowed"),
        JSON.stringify({ type: "result", session_id: "session-rl", result: "Hi", is_error: false }),
      ].join("\n");

      expect(extractCliErrorMessage(jsonl)).toBeNull();
    });

    it("surfaces rejected as a rate_limit error string (not billing)", () => {
      const jsonl = buildRateLimitEventJsonl("rejected", "seven_day");

      const msg = extractCliErrorMessage(jsonl);
      expect(msg).toMatch(/rate limit exceeded/i);
      expect(msg).toMatch(/seven_day/i);
      // Must not contain billing keywords that would trigger the billing classifier
      expect(msg?.toLowerCase()).not.toMatch(/billing|payment|credit|subscription/);
    });
  });

  describe("parseCliJsonl — rate_limit_event pass-through", () => {
    it("parses the result line normally when allowed_warning precedes it", () => {
      const jsonl = [
        buildRateLimitEventJsonl("allowed_warning"),
        JSON.stringify({
          type: "result",
          session_id: "session-rl-ok",
          result: "Hello!",
          usage: { input_tokens: 10, output_tokens: 3 },
        }),
      ].join("\n");

      const result = parseCliJsonl(jsonl, RATE_LIMIT_EVENT_BACKEND, "claude-cli");

      expect(result).toEqual({
        text: "Hello!",
        sessionId: "session-rl-ok",
        usage: {
          input: 10,
          output: 3,
          cacheRead: undefined,
          cacheWrite: undefined,
          total: undefined,
        },
      });
    });
  });
});
