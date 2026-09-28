import { describe, expect, it } from "vitest";
import type { CliToolResultDelta, CliToolUseStartDelta } from "./cli-output-contracts.js";
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
