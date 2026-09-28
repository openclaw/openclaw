import { describe, expect, it } from "vitest";
import type { CliToolResultDelta, CliToolUseStartDelta } from "./cli-output-contracts.js";
import { createToolUseTracker, dispatchClaudeCliStreamingToolEvent } from "./cli-output-events.js";
import { CLI_STREAM_JSON_OUTPUT_LIMITS } from "./cli-output-stream-limits.js";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";

const PARENT_TOOL_CALL_ID = "toolu_parent_agent";

function createRecordingParser() {
  const assistantDeltas: string[] = [];
  const toolStarts: CliToolUseStartDelta[] = [];
  const toolResults: CliToolResultDelta[] = [];
  const attributedProgress: string[] = [];
  const parser = createCliJsonlStreamingParser({
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    providerId: "claude-cli",
    onAssistantDelta: (delta) => assistantDeltas.push(delta.delta),
    onToolUseStart: (tool) => toolStarts.push(tool),
    onToolResult: (result) => toolResults.push(result),
    onAttributedSubagentProgress: (parentToolUseId) => attributedProgress.push(parentToolUseId),
  });
  return { parser, assistantDeltas, toolStarts, toolResults, attributedProgress };
}

/** One forwarded subagent record, as Claude Code writes it on the parent's stdout. */
function subagentLine(text: string) {
  return JSON.stringify({
    type: "assistant",
    parent_tool_use_id: PARENT_TOOL_CALL_ID,
    message: { id: "msg_subagent", content: [{ type: "text", text }] },
  });
}

function parentAssistantTextLine(text: string) {
  return JSON.stringify({
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  });
}

function parentToolUseLine(toolCallId: string, name: string) {
  return JSON.stringify({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id: "msg_parent_tool",
      content: [{ type: "tool_use", id: toolCallId, name, input: { command: "true" } }],
    },
  });
}

function parentToolResultLine(toolCallId: string) {
  return JSON.stringify({
    type: "user",
    parent_tool_use_id: null,
    message: {
      content: [{ type: "tool_result", tool_use_id: toolCallId, content: "Exit code 1" }],
    },
  });
}

function terminalResultLine(result: string) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    result,
    session_id: "budget-session",
  });
}

describe("CLI stream-json turn budget and forwarded subagent traffic", () => {
  it("does not charge forwarded subagent traffic against the parent line budget", () => {
    const { parser, assistantDeltas } = createRecordingParser();

    const subagentFlood = `${subagentLine("subagent chatter")}\n`.repeat(
      CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnLines + 5_000,
    );
    parser.push(subagentFlood);
    parser.push(`${parentAssistantTextLine("parent answer")}\n`);
    parser.push(`${terminalResultLine("parent answer")}\n`);
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutputTruncationText()).toBeNull();
    expect(assistantDeltas.join("")).toBe("parent answer");
    expect(parser.getOutput()).toMatchObject({ text: "parent answer" });
  });

  it("does not charge forwarded subagent traffic against the parent character budget", () => {
    const { parser, assistantDeltas } = createRecordingParser();

    const halfBudgetText = "s".repeat(Math.ceil(CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnRawChars / 2));
    parser.push(`${subagentLine(halfBudgetText)}\n`);
    parser.push(`${subagentLine(halfBudgetText)}\n`);
    parser.push(`${parentAssistantTextLine("parent answer")}\n`);
    parser.push(`${terminalResultLine("parent answer")}\n`);
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutputTruncationText()).toBeNull();
    expect(assistantDeltas.join("")).toBe("parent answer");
  });

  it("still charges parent-lane records that carry an explicit null parent tool id", () => {
    const { parser } = createRecordingParser();

    parser.push(
      `${parentAssistantTextLine("x")}\n`.repeat(CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnLines + 1),
    );
    parser.push(`${terminalResultLine("recovered")}\n`);
    parser.finish();

    expect(parser.getOutputTruncationText()).toContain("JSONL output exceeded 20000 lines");
  });

  it("keeps emitting parent tool start and result past an exhausted budget", () => {
    const { parser, toolStarts, toolResults } = createRecordingParser();

    parser.push("\n".repeat(CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnLines + 1));
    expect(toolStarts).toEqual([]);

    parser.push(`${parentToolUseLine("toolu_bash_after_budget", "Bash")}\n`);
    parser.push(`${parentToolResultLine("toolu_bash_after_budget")}\n`);
    parser.push(`${terminalResultLine("finished answer")}\n`);
    parser.finish();

    expect(toolStarts.map((tool) => [tool.toolCallId, tool.name])).toEqual([
      ["toolu_bash_after_budget", "Bash"],
    ]);
    expect(toolResults.map((result) => result.toolCallId)).toEqual(["toolu_bash_after_budget"]);
    // The finished turn is still recovered, exactly as before this change.
    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()).toMatchObject({ text: "finished answer" });
  });

  it("keeps reporting attributed subagent progress past an exhausted budget", () => {
    const { parser, attributedProgress } = createRecordingParser();

    parser.push("\n".repeat(CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnLines + 1));
    parser.push(`${subagentLine("still working")}\n`);
    parser.finish();

    expect(attributedProgress).toEqual([PARENT_TOOL_CALL_ID]);
  });

  it("does not assemble parent assistant text past an exhausted budget", () => {
    const { parser, assistantDeltas } = createRecordingParser();

    parser.push("\n".repeat(CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnLines + 1));
    parser.push(`${parentAssistantTextLine("dropped")}\n`);
    parser.finish();

    expect(assistantDeltas).toEqual([]);
  });
});

/** A genuine parent record whose nested payload also carries the field. */
function parentTextLineWithNestedSubagentId(text: string) {
  return JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    tool_use_result: { forwarded: [{ type: "assistant", parent_tool_use_id: "toolu_nested" }] },
    parent_tool_use_id: null,
  });
}

describe("raw-line exemption agrees with decoded top-level ownership", () => {
  it("charges and assembles a parent record that nests a subagent parent tool id", () => {
    const { parser, assistantDeltas } = createRecordingParser();

    parser.push(`${parentTextLineWithNestedSubagentId("assembled")}\n`);
    // The line is parent traffic, so the parent lane assembles it. Accounting
    // has to agree: exempting it would spend nothing while it still produces
    // parent output.
    expect(assistantDeltas.join("")).toBe("assembled");

    parser.push(
      `${parentTextLineWithNestedSubagentId("x")}\n`.repeat(
        CLI_STREAM_JSON_OUTPUT_LIMITS.maxTurnLines + 1,
      ),
    );
    parser.push(`${terminalResultLine("recovered")}\n`);
    parser.finish();

    expect(parser.getOutputTruncationText()).toContain("JSONL output exceeded 20000 lines");
  });
});

const CLAUDE_TOOL_BACKEND = {
  backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
  providerId: "claude-cli",
} as const;

function dispatchToTracker(
  tracker: ReturnType<typeof createToolUseTracker>,
  parsed: Record<string, unknown>,
  sinks?: {
    onToolUseStart?: (d: CliToolUseStartDelta) => void;
    onToolResult?: (d: CliToolResultDelta) => void;
  },
) {
  dispatchClaudeCliStreamingToolEvent({
    ...CLAUDE_TOOL_BACKEND,
    parsed,
    tracker,
    ...(sinks?.onToolUseStart ? { onToolUseStart: sinks.onToolUseStart } : {}),
    ...(sinks?.onToolResult ? { onToolResult: sinks.onToolResult } : {}),
  });
}

describe("tool use tracker retention bounds", () => {
  it("keeps reporting every repeated tool call while bounding retained ids", () => {
    const tracker = createToolUseTracker();
    const starts: string[] = [];
    const results: string[] = [];
    const total = 20_000;

    for (let index = 0; index < total; index += 1) {
      const toolCallId = `toolu_repeat_${index}`;
      dispatchToTracker(
        tracker,
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: toolCallId, name: "Bash", input: { command: "true" } },
            ],
          },
        },
        { onToolUseStart: (tool) => starts.push(tool.toolCallId) },
      );
      dispatchToTracker(
        tracker,
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: toolCallId, content: "ok" }] },
        },
        { onToolResult: (result) => results.push(result.toolCallId) },
      );
    }

    // Progress reporting is preserved: every call still produced both events.
    expect(starts).toHaveLength(total);
    expect(results).toHaveLength(total);
    // Retention is not: the tracker holds a bounded window, not the whole turn.
    expect(tracker.startedIds.size).toBeLessThanOrEqual(4096);
    expect(tracker.nameById.size).toBeLessThanOrEqual(4096);
    expect(tracker.resultDeliveredIds.size).toBeLessThanOrEqual(4096);
    expect(tracker.startedIds.has(`toolu_repeat_${total - 1}`)).toBe(true);
  });

  it("bounds buffered arguments of a tool call whose stop never arrives", () => {
    const tracker = createToolUseTracker();
    const starts: CliToolUseStartDelta[] = [];
    const chunk = "a".repeat(512 * 1024);
    const chunks = 24; // 12 MiB streamed against an 8 MiB bound.

    dispatchToTracker(tracker, {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_unfinished",
          name: "Write",
          input: { path: "x" },
        },
      },
    });
    for (let index = 0; index < chunks; index += 1) {
      dispatchToTracker(tracker, {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: chunk },
        },
      });
    }

    const buffered = [...tracker.pendingByIndex.values()].reduce(
      (sum, pending) =>
        sum + pending.inputJsonParts.reduce((parts, part) => parts + part.length, 0),
      0,
    );
    expect(buffered).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(buffered).toBeLessThan(chunk.length * chunks);
    expect(tracker.pendingInputChars).toBeLessThanOrEqual(8 * 1024 * 1024);

    // The bound costs the streamed arguments, never the progress signal: the
    // block still settles into a start event when its stop finally arrives.
    dispatchToTracker(
      tracker,
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { onToolUseStart: (tool) => starts.push(tool) },
    );
    expect(starts.map((tool) => [tool.toolCallId, tool.name])).toEqual([
      ["toolu_unfinished", "Write"],
    ]);
    expect(tracker.pendingByIndex.size).toBe(0);
    expect(tracker.pendingInputChars).toBe(0);
  });

  it("bounds pending tool blocks that never stop", () => {
    const tracker = createToolUseTracker();
    for (let index = 0; index < 1_000; index += 1) {
      dispatchToTracker(tracker, {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: `toolu_pending_${index}`, name: "Bash" },
        },
      });
    }
    expect(tracker.pendingByIndex.size).toBeLessThanOrEqual(256);
  });
});
