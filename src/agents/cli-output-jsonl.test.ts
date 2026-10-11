import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";
import { parseCliOutput } from "./cli-output.js";

type ParseCliOutputParams = Parameters<typeof parseCliOutput>[0];

function parseCliJsonl(
  raw: string,
  backend: ParseCliOutputParams["backend"] = {
    command: "claude",
    output: "jsonl",
    sessionIdFields: ["session_id"],
  },
  providerId = "claude-cli",
) {
  return parseCliOutput({ raw, backend, providerId, outputMode: "jsonl" });
}

function joinJsonlFrames(...frames: unknown[]) {
  return frames
    .map((frame) => (typeof frame === "string" ? frame : JSON.stringify(frame)))
    .join("\n");
}

function claudeStreamEvent(event: Record<string, unknown>) {
  return { type: "stream_event", event };
}

function claudeMessageStart(id?: string) {
  return claudeStreamEvent({ type: "message_start", ...(id ? { message: { id } } : {}) });
}

function claudeTextDelta(text: string, index?: number | string) {
  return claudeStreamEvent({
    type: "content_block_delta",
    ...(index === undefined ? {} : { index }),
    delta: { type: "text_delta", text },
  });
}

function claudeThinkingDelta(thinking: string, index?: number | string) {
  return claudeStreamEvent({
    type: "content_block_delta",
    ...(index === undefined ? {} : { index }),
    delta: { type: "thinking_delta", thinking },
  });
}

function normalizedUsage(values: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}) {
  return {
    input: values.input,
    output: values.output,
    cacheRead: values.cacheRead,
    cacheWrite: values.cacheWrite,
    total: values.total,
  };
}

describe("parseCliJsonl", () => {
  it("continues transcript reparses past an interim result", () => {
    const result = parseCliJsonl(
      joinJsonlFrames(
        { type: "init", session_id: "session-interim-reparse" },
        claudeMessageStart(),
        claudeTextDelta("Interim answer."),
        {
          type: "result",
          session_id: "session-interim-reparse",
          result: "Interim answer.",
        },
        claudeMessageStart(),
        claudeTextDelta("Pre-tool follow-up."),
        claudeStreamEvent({
          type: "content_block_start",
          content_block: { type: "tool_use", id: "tool-2", name: "session_status" },
        }),
        claudeTextDelta("DONE"),
        {
          type: "result",
          session_id: "session-interim-reparse",
          result: "DONE",
        },
      ),
      {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      "local-cli",
    );

    expect(result?.text).toBe("Interim answer.\nPre-tool follow-up.\n\nDONE");
  });

  it.each([
    {
      name: "keeps detailed Gemini stream-json error events over generic result errors",
      frames: [
        {
          type: "error",
          timestamp: "2026-06-16T19:36:48.000Z",
          severity: "error",
          message: "Invalid stream payload",
        },
        {
          type: "result",
          timestamp: "2026-06-16T19:36:49.000Z",
          status: "error",
          stats: { total_tokens: 1 },
        },
      ],
      sessionIdFields: undefined,
      expected: {
        text: "",
        sessionId: undefined,
        usage: normalizedUsage({ total: 1 }),
        errorText: "Invalid stream payload",
      },
    },
  ])("$name", ({ frames, sessionIdFields, expected }) => {
    const result = parseCliJsonl(
      joinJsonlFrames(...frames),
      {
        command: "gemini",
        output: "jsonl",
        jsonlDialect: "gemini-stream-json",
        ...(sessionIdFields ? { sessionIdFields } : {}),
      },
      "google-gemini-cli",
    );

    expect(result).toEqual(expected);
  });

  it("does not let cumulative Claude result usage overwrite assistant usage", () => {
    const result = parseCliJsonl(
      joinJsonlFrames(
        { type: "init", session_id: "session-stream" },
        {
          type: "assistant",
          message: {
            id: "msg-1",
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
          },
        },
        {
          type: "assistant",
          message: {
            id: "msg-2",
            usage: { input_tokens: 11, output_tokens: 6, cache_read_input_tokens: 125 },
          },
        },
        {
          type: "result",
          session_id: "session-stream",
          result: "done",
          usage: { input_tokens: 30, output_tokens: 15, cache_read_input_tokens: 300 },
        },
      ),
    );

    expect(result?.usage).toEqual({
      input: 11,
      output: 6,
      cacheRead: 125,
      cacheWrite: undefined,
      total: undefined,
    });
  });

  it.each([
    {
      name: "unwraps nested Claude agent result JSON from stream-json output",
      raw: joinJsonlFrames(
        { type: "init", session_id: "session-nested-jsonl" },
        {
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
        },
      ),
      expected: {
        text: "actual response text",
        sessionId: "session-nested-jsonl",
        usage: undefined,
      },
    },
    {
      name: "does not carry unmatched banner quote state into the next JSONL line",
      raw: 'banner "unterminated\n{"type":"init","session_id":"session-999"}\n{"type":"result","result":"done"}',
      expected: { text: "done", sessionId: "session-999", usage: undefined },
    },
  ])("$name", ({ raw, expected }) => {
    const result = parseCliJsonl(raw);

    expect(result).toEqual(expected);
  });

  it("captures the last Claude session_id when an ephemeral id precedes the canonical one", () => {
    // claude-cli emits ephemeral session_ids from SessionStart hooks before the
    // canonical resumed session_id surfaces in the init event and the terminal
    // result event. First-wins capture would bind to the ephemeral id whose
    // transcript JSONL never lands on disk; last-wins captures the canonical id.
    const result = parseCliJsonl(
      joinJsonlFrames(
        { type: "system", subtype: "init", session_id: "session-ephemeral" },
        { type: "system", subtype: "init", session_id: "session-canonical" },
        {
          type: "result",
          session_id: "session-canonical",
          result: "rotated reply",
        },
      ),
    );

    expect(result?.sessionId).toBe("session-canonical");
    expect(result?.text).toBe("rotated reply");
  });

  it("preserves terminal cumulative usage when reparsing completed Claude JSONL", () => {
    const output = parseCliJsonl(
      readFileSync("test/fixtures/cli/claude-2.1-thinking-progress.jsonl", "utf8"),
      {
        command: "claude",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(output.usage).toEqual({
      input: 4418,
      output: 5,
      cacheRead: undefined,
      cacheWrite: 36955,
      total: undefined,
    });
    expect(output.diagnosticUsage).toEqual({
      input: 4418,
      output: 534,
      cacheRead: undefined,
      cacheWrite: 36955,
      total: undefined,
    });
  });

  it("keeps subagent thinking, tools, and messages out of the parent lane", () => {
    // Claude Code 2.1.234 capture: an Agent (Explore) subagent runs in the
    // background; its assistant/user records carry parent_tool_use_id.
    const thinking: string[] = [];
    const toolStarts: string[] = [];
    const toolResults: string[] = [];
    const assistantMessages: unknown[] = [];
    let text = "";
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "claude",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: (delta) => {
        text = delta.text;
      },
      onThinkingDelta: (delta) => thinking.push(delta.delta),
      onToolUseStart: (delta) => toolStarts.push(delta.name),
      onToolResult: (delta) => toolResults.push(delta.toolCallId),
      onAssistantMessage: (message) => assistantMessages.push(message),
    });

    parser.push(readFileSync("test/fixtures/cli/claude-2.1-subagent-forwarding.jsonl", "utf8"));
    parser.finish();

    expect(toolStarts).toEqual(["Agent"]);
    expect(toolResults).toEqual(["toolu_01Vbp51dKsXzRPji7mxf92vG"]);
    expect(thinking.join("")).not.toContain("The Glob tool returned no files found");
    expect(thinking.join("")).toContain("The agent has completed");
    expect(assistantMessages).toHaveLength(6);
    expect(text).toBe(
      "Agent is running. I'll let you know the count when it finishes.\n\nThere are **7 .d.ts files** in the ./package directory.",
    );
    expect(parser.getOutput()?.text).toBe(
      "Agent is running. I'll let you know the count when it finishes.\nThere are **7 .d.ts files** in the ./package directory.",
    );
  });

  it("reports semantic subagent records without admitting them to the parent lane", () => {
    const progress: string[] = [];
    const toolStarts: string[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "claude",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
      onToolUseStart: (delta) => toolStarts.push(delta.name),
      onAttributedSubagentProgress: (parentToolUseId) => progress.push(parentToolUseId),
    });
    const parentId = "toolu_parent";
    parser.push(
      joinJsonlFrames(
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: parentId, name: "Agent", input: {} }],
          },
        },
        {
          type: "stream_event",
          parent_tool_use_id: parentId,
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "still working" },
          },
        },
        {
          type: "assistant",
          parent_tool_use_id: parentId,
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "reading the tree" }],
          },
        },
        {
          type: "assistant",
          parent_tool_use_id: "toolu_other",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_child", name: "Read", input: {} }],
          },
        },
        {
          type: "user",
          parent_tool_use_id: parentId,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_child", content: "ok" }],
          },
        },
        { type: "system", subtype: "task_progress", parent_tool_use_id: parentId },
      ),
    );
    parser.finish();

    expect(toolStarts).toEqual(["Agent"]);
    expect(progress).toEqual([parentId, "toolu_other", parentId]);
  });

  it.each([
    {
      name: "ignores indexless thinking deltas without content block framing",
      frames: [claudeThinkingDelta("orphaned"), claudeThinkingDelta("also orphaned", "0")],
      expected: [],
    },
  ])("$name", ({ frames, expected }) => {
    const thinking: Array<{ text: string; delta: string; isReasoningSnapshot?: boolean }> = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "local-cli",
      onAssistantDelta: () => {},
      onThinkingDelta: (delta) => thinking.push(delta),
    });

    parser.push(joinJsonlFrames(...frames));
    parser.finish();

    expect(thinking).toEqual(expected);
  });
});
