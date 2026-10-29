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
const initFrame = (session_id: string) => ({ type: "init", session_id });
const geminiMessage = (content: string, delta?: boolean) => ({
  type: "message",
  role: "assistant",
  content,
  ...(delta ? { delta } : {}),
});
const geminiResult = (stats: Record<string, number>) => ({
  type: "result",
  status: "success",
  stats,
});
const geminiTool = (name: string, output: string, parameters = {}) => [
  { type: "tool_use", tool_name: name, tool_id: "tool-1", parameters },
  { type: "tool_result", tool_id: "tool-1", status: "success", output },
];

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
const parseFrames = (...frames: unknown[]) => parseCliJsonl(joinJsonlFrames(...frames));
const userRecord = (content: unknown[], fields: Record<string, unknown> = {}) => ({
  type: "user",
  message: { role: "user", content },
  ...fields,
});
const toolResult = (id: string) => ({ type: "tool_result", tool_use_id: id, content: "ok" });

describe("parseCliJsonl", () => {
  it("parses Claude result and cache usage for an explicit backend dialect", () => {
    const result = parseCliJsonl(
      joinJsonlFrames(
        initFrame("session-dialect"),
        resultFrame("dialect says hello", {
          session_id: "session-dialect",
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 7,
          },
        }),
      ),
      createClaudeBackend("local-cli"),
      "local-cli",
    );
    expect(result).toEqual({
      text: "dialect says hello",
      sessionId: "session-dialect",
      usage: { input: 12, output: 3, cacheRead: 4, cacheWrite: 7, total: undefined },
    });
  });

  const stopHookFeedback = userRecord([textBlock("Stop hook feedback:\nRewrite.")], {
    parent_tool_use_id: null,
  });
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
    userRecord([toolResult(id)]),
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
        userRecord([textBlock("Check README.md too.")], {
          isReplay: true,
          parent_tool_use_id: null,
        }),
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
      const result = parseFrames(
        ...textFrames("A", "draft"),
        ...feedback,
        ...(tool ? toolRoundTrip("read-1") : []),
        ...textFrames(rewrite, "rewrite"),
        resultFrame(rewrite),
      );

      expect(result.text).toBe(expected);
    },
  );

  it("discards each rejected segment across repeated Stop-hook bounces", () => {
    const result = parseFrames(
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
    );

    expect(result.text).toBe("C");
  });

  it.each([
    {
      name: "parses Gemini stream-json message and result events",
      frames: [
        geminiMessage("Gemini says ", true),
        geminiMessage("hello", true),
        geminiResult({ total_tokens: 21, input_tokens: 13, output_tokens: 5, cached: 8, input: 5 }),
      ],
      text: "Gemini says hello",
      usage: { input: 5, output: 5, cacheRead: 8, total: 21 },
    },
    {
      name: "keeps Gemini tool-only stream-json output structured instead of raw JSONL",
      frames: [
        ...geminiTool("mcp_openclaw_create_goal", "created", { objective: "Update files" }),
        geminiResult({ total_tokens: 2, input_tokens: 1, output_tokens: 1 }),
      ],
      text: "",
      usage: { input: 1, output: 1, total: 2 },
    },
  ])("$name", ({ frames, text, usage }) => {
    const result = parseCliJsonl(
      joinJsonlFrames(initFrame("gemini-session-123"), ...frames),
      { ...createGeminiBackend(), sessionIdFields: ["session_id"] },
      "google-gemini-cli",
    );

    expect(result).toEqual({ text, sessionId: "gemini-session-123", usage });
  });

  it.each([
    { name: "no tool call", tool: false, final: true, expected: "Checking tools.Done." },
    { name: "a tool-only ending", tool: true, final: false, expected: "" },
  ])("records only the final Gemini message ($name)", ({ tool, final, expected }) => {
    const result = parseCliJsonl(
      joinJsonlFrames(
        initFrame("gemini-final"),
        geminiMessage("Checking tools."),
        ...(tool ? geminiTool("read_file", "ok") : []),
        ...(final ? [geminiMessage("Done.")] : []),
        geminiResult({ total_tokens: 2 }),
      ),
      createGeminiBackend(),
      "google-gemini-cli",
    );

    // rawFinalText is omitted when the final message equals the reply text.
    expect(result?.rawFinalText ?? result?.text.trim()).toBe(expected);
  });

  it("captures the last Claude assistant transcript UUID as a resume checkpoint", () => {
    const result = parseFrames(
      { type: "system", subtype: "init", session_id: "session-checkpoint" },
      ...["first", "done"].map((text, i) =>
        assistantRecord(
          [textBlock(text)],
          { uuid: `assistant-checkpoint-${i + 1}` },
          `provider-message-${i + 1}`,
        ),
      ),
      assistantRecord(
        [textBlock("nested")],
        { uuid: "subagent-checkpoint", parent_tool_use_id: "tool-use-1" },
        "provider-subagent-message",
      ),
      resultFrame("done", { session_id: "session-checkpoint" }),
    );

    expect(result?.resumeCheckpointId).toBe("assistant-checkpoint-2");
  });

  const sessionId = "session-456";
  it.each([
    [
      "empty final metadata",
      joinJsonlFrames(
        initFrame(sessionId),
        resultFrame("   ", {
          session_id: sessionId,
          usage: { input_tokens: 18, output_tokens: 0 },
        }),
      ),
      "",
      { input: 18 },
    ],
    [
      "unmatched banner quote",
      `banner "unterminated\n{"type":"init","session_id":"${sessionId}"}\n{"type":"result","result":"done"}`,
      "done",
      undefined,
    ],
  ] as const)("parses Claude JSONL with %s", (_name, raw, text, usage) => {
    expect(parseCliJsonl(raw)).toEqual({ text, sessionId, usage });
  });

  it("captures the last Claude session_id when an ephemeral id precedes the canonical one", () => {
    // SessionStart hooks can emit ephemeral IDs whose transcripts never land on disk.
    const result = parseFrames(
      { type: "system", subtype: "init", session_id: "session-ephemeral" },
      { type: "system", subtype: "init", session_id: "session-canonical" },
      resultFrame("rotated reply", { session_id: "session-canonical" }),
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
