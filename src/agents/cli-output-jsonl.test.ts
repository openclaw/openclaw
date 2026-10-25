import { readFileSync } from "node:fs";
import { calculateUsageCost } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { parseCliOutput } from "./cli-output.js";
import {
  claudeMessageStart,
  claudeMessageStop,
  claudeStreamEvent,
  claudeTextDelta,
  createClaudeParser,
  createClaudeBackend,
  createGeminiBackend,
  joinJsonlFrames,
} from "./cli-output.test-helpers.js";

type ParseCliOutputParams = Parameters<typeof parseCliOutput>[0];

const resultFrame = (result: string, fields: Record<string, unknown> = {}) => ({
  type: "result",
  result,
  ...fields,
});
const textFrames = (text: string, id?: string) => [
  claudeMessageStart(id),
  claudeTextDelta(text),
  claudeMessageStop(),
];
const assistantRecord = (
  content: unknown[],
  fields: Record<string, unknown> = {},
  id?: string,
) => ({
  type: "assistant",
  message: { role: "assistant", content, ...(id ? { id } : {}) },
  ...fields,
});
const textBlock = (text: string) => ({ type: "text", text });

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

describe("parseCliJsonl", () => {
  it("parses Claude stream-json result events for an explicit backend dialect", () => {
    const result = parseCliJsonl(
      joinJsonlFrames(
        { type: "init", session_id: "session-dialect" },
        resultFrame("dialect says hello", {
          session_id: "session-dialect",
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
      ),
      createClaudeBackend("local-cli"),
      "local-cli",
    );
    expect(result).toEqual({
      text: "dialect says hello",
      sessionId: "session-dialect",
      usage: { input: 5, output: 2 },
    });
  });

  const stopHookFeedback = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "Stop hook feedback:\nRewrite." }] },
    parent_tool_use_id: null,
  };
  const stopHookNotification = {
    type: "system",
    subtype: "notification",
    key: "stop-hook-error",
  };
  const toolRoundTrip = (id: string) => [
    claudeMessageStart(`tool-message-${id}`),
    claudeStreamEvent({
      type: "content_block_start",
      content_block: { type: "tool_use", id, name: "Read" },
    }),
    claudeMessageStop(),
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
      },
    },
  ];

  const rejection = [stopHookFeedback, stopHookNotification];
  it.each([
    ["Stop-hook rejection before a tool", rejection, "B", "B", true],
    ["rewrite without a tool", rejection, "B", "B", false],
    ["notification", [stopHookNotification], "B", "B", true],
    ["silent rewrite", rejection, "NO_REPLY", "NO_REPLY", true],
    ["ordinary tool split", [], "B", "A\n\nB", true],
    [
      "replayed user steering",
      [
        {
          type: "user",
          isReplay: true,
          parent_tool_use_id: null,
          message: { role: "user", content: [{ type: "text", text: "Check README.md too." }] },
        },
      ],
      "B",
      "A\n\nB",
      true,
    ],
    ["user text without a rejection notification", [stopHookFeedback], "B", "A\n\nB", true],
    [
      "subagent feedback and unrelated notification",
      [
        { ...stopHookFeedback, parent_tool_use_id: "subagent-1" },
        { ...stopHookNotification, parent_tool_use_id: "subagent-1" },
        { ...stopHookNotification, key: "tool-progress" },
      ],
      "B",
      "A\n\nB",
      true,
    ],
  ] as const)(
    "selects the final reply across Claude stream boundaries (%s)",
    (_name, feedback, rewrite, expected, tool) => {
      const result = parseCliJsonl(
        joinJsonlFrames(
          ...textFrames("A", "draft"),
          ...feedback,
          ...(tool ? toolRoundTrip("read-1") : []),
          ...textFrames(rewrite, "rewrite"),
          resultFrame(rewrite),
        ),
      );

      expect(result.text).toBe(expected);
    },
  );

  it("discards each rejected segment across repeated Stop-hook bounces", () => {
    const result = parseCliJsonl(
      joinJsonlFrames(
        ...textFrames("A", "first-draft"),
        stopHookFeedback,
        stopHookNotification,
        ...toolRoundTrip("read-1"),
        ...textFrames("B", "second-draft"),
        stopHookFeedback,
        stopHookNotification,
        ...toolRoundTrip("read-2"),
        claudeMessageStart("rewrite"),
        claudeTextDelta("C"),
        resultFrame("C"),
      ),
    );

    expect(result.text).toBe("C");
  });

  it.each([
    {
      name: "parses Gemini stream-json message and result events",
      frames: [
        {
          type: "init",
          session_id: "gemini-session-123",
          model: "gemini-3.1-pro-preview",
        },
        {
          type: "message",
          role: "assistant",
          content: "Gemini says ",
          delta: true,
        },
        {
          type: "message",
          role: "assistant",
          content: "hello",
          delta: true,
        },
        {
          type: "result",
          status: "success",
          stats: { total_tokens: 21, input_tokens: 13, output_tokens: 5, cached: 8, input: 5 },
        },
      ],
      sessionIdFields: ["session_id"],
      expected: {
        text: "Gemini says hello",
        sessionId: "gemini-session-123",
        usage: { input: 5, output: 5, cacheRead: 8, total: 21 },
      },
    },
    {
      name: "keeps Gemini tool-only stream-json output structured instead of raw JSONL",
      frames: [
        {
          type: "init",
          session_id: "gemini-session-123",
          model: "gemini-3.1-pro-preview",
        },
        {
          type: "tool_use",
          tool_name: "mcp_openclaw_create_goal",
          tool_id: "tool-1",
          parameters: { objective: "Update files" },
        },
        {
          type: "tool_result",
          tool_id: "tool-1",
          status: "success",
          output: "created",
        },
        {
          type: "result",
          status: "success",
          stats: { total_tokens: 2, input_tokens: 1, output_tokens: 1 },
        },
      ],
      sessionIdFields: ["session_id"],
      expected: {
        text: "",
        sessionId: "gemini-session-123",
        usage: { input: 1, output: 1, total: 2 },
      },
    },
  ])("$name", ({ frames, sessionIdFields, expected }) => {
    const result = parseCliJsonl(
      joinJsonlFrames(...frames),
      { ...createGeminiBackend(), sessionIdFields },
      "google-gemini-cli",
    );

    expect(result).toEqual(expected);
  });

  it.each([
    { name: "no tool call", tool: false, final: true, expected: "Checking tools.Done." },
    { name: "text after a tool call", tool: true, final: true, expected: "Done." },
    { name: "a tool-only ending", tool: true, final: false, expected: "" },
  ])("records only the final Gemini message ($name)", ({ tool, final, expected }) => {
    const message = (content: string) => ({ type: "message", role: "assistant", content });
    const result = parseCliJsonl(
      joinJsonlFrames(
        { type: "init", session_id: "gemini-final" },
        message("Checking tools."),
        ...(tool
          ? [
              { type: "tool_use", tool_name: "read_file", tool_id: "tool-1", parameters: {} },
              { type: "tool_result", tool_id: "tool-1", status: "success", output: "ok" },
            ]
          : []),
        ...(final ? [message("Done.")] : []),
        { type: "result", status: "success", stats: { total_tokens: 2 } },
      ),
      createGeminiBackend(),
      "google-gemini-cli",
    );

    // rawFinalText is omitted when the final message equals the reply text.
    expect(result?.rawFinalText ?? result?.text.trim()).toBe(expected);
  });

  it("preserves Claude cache creation tokens instead of flattening them to zero", () => {
    const result = parseCliJsonl(
      joinJsonlFrames(
        { type: "init", session_id: "session-cache-123" },
        resultFrame("Claude says hello", {
          session_id: "session-cache-123",
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 7,
          },
        }),
      ),
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

  it("captures the last Claude assistant transcript UUID as a resume checkpoint", () => {
    const result = parseCliJsonl(
      joinJsonlFrames(
        { type: "system", subtype: "init", session_id: "session-checkpoint" },
        assistantRecord(
          [textBlock("first")],
          { uuid: "assistant-checkpoint-1" },
          "provider-message-1",
        ),
        assistantRecord(
          [textBlock("done")],
          { uuid: "assistant-checkpoint-2" },
          "provider-message-2",
        ),
        assistantRecord(
          [textBlock("nested")],
          {
            uuid: "subagent-checkpoint",
            parent_tool_use_id: "tool-use-1",
          },
          "provider-subagent-message",
        ),
        resultFrame("done", { session_id: "session-checkpoint" }),
      ),
    );

    expect(result?.resumeCheckpointId).toBe("assistant-checkpoint-2");
  });

  it.each([
    {
      name: "preserves Claude session metadata even when the final result text is empty",
      raw: joinJsonlFrames(
        { type: "init", session_id: "session-456" },
        resultFrame("   ", {
          session_id: "session-456",
          usage: { input_tokens: 18, output_tokens: 0 },
        }),
      ),
      expected: {
        text: "",
        sessionId: "session-456",
        usage: { input: 18 },
      },
    },
    {
      name: "unwraps nested Claude agent result JSON from stream-json output",
      raw: joinJsonlFrames(
        { type: "init", session_id: "session-nested-jsonl" },
        resultFrame(
          JSON.stringify(
            resultFrame(
              JSON.stringify(
                resultFrame("actual response text", {
                  subtype: "success",
                }),
              ),
            ),
          ),
          { session_id: "session-nested-jsonl" },
        ),
      ),
      expected: {
        text: "actual response text",
        sessionId: "session-nested-jsonl",
        usage: undefined,
      },
    },
    {
      name: "parses multiple JSON objects embedded on the same line",
      raw: '{"type":"init","session_id":"session-999"} {"type":"result","session_id":"session-999","result":"done"}',
      expected: { text: "done", sessionId: "session-999", usage: undefined },
    },
    {
      name: "skips quoted banners while retaining same-line JSONL metadata",
      raw: 'banner "use { for JSON" {"type":"init","session_id":"session-999"} {"type":"result","result":"done"}',
      expected: { text: "done", sessionId: "session-999", usage: undefined },
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
        resultFrame("rotated reply", { session_id: "session-canonical" }),
      ),
    );

    expect(result?.sessionId).toBe("session-canonical");
    expect(result?.text).toBe("rotated reply");
  });

  it("preserves terminal cumulative usage when reparsing completed Claude JSONL", () => {
    const output = parseCliJsonl(
      readFileSync("test/fixtures/cli/claude-2.1-thinking-progress.jsonl", "utf8"),
      createClaudeBackend("claude"),
      "claude-cli",
    );

    expect(output.usage).toEqual({
      input: 4418,
      output: 5,
      cacheRead: undefined,
      cacheWrite: 36955,
      cacheWrite1h: 36955,
      total: undefined,
    });
    expect(output.diagnosticUsage).toEqual({
      input: 4418,
      output: 534,
      cacheRead: undefined,
      cacheWrite: 36955,
      cacheWrite1h: 36955,
      total: undefined,
    });
    // Every write in this turn used the 1h TTL; the CLI reports costUSD 0.40499 for it.
    const opus48 = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
    expect(calculateUsageCost(output.diagnosticUsage ?? {}, opus48).total).toBeCloseTo(0.40499, 8);
  });

  it("keeps subagent thinking, tools, and messages out of the parent lane", () => {
    // Claude Code 2.1.234 capture: an Agent (Explore) subagent runs in the
    // background; its assistant/user records carry parent_tool_use_id.
    const thinking: string[] = [];
    const toolStarts: string[] = [];
    const toolResults: string[] = [];
    const assistantMessages: unknown[] = [];
    let text = "";
    const parser = createClaudeParser({
      backend: createClaudeBackend("claude"),
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
    const parser = createClaudeParser({
      backend: createClaudeBackend("claude"),
      onToolUseStart: (delta) => toolStarts.push(delta.name),
      onAttributedSubagentProgress: (parentToolUseId) => progress.push(parentToolUseId),
    });
    const parentId = "toolu_parent";
    parser.push(
      joinJsonlFrames(
        assistantRecord([{ type: "tool_use", id: parentId, name: "Agent", input: {} }]),
        {
          type: "stream_event",
          parent_tool_use_id: parentId,
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "still working" },
          },
        },
        assistantRecord([{ type: "thinking", thinking: "reading the tree" }], {
          parent_tool_use_id: parentId,
        }),
        assistantRecord([{ type: "tool_use", id: "toolu_child", name: "Read", input: {} }], {
          parent_tool_use_id: "toolu_other",
        }),
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
});
