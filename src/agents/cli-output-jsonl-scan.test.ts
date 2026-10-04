import { describe, expect, it } from "vitest";
import { isClaudeSubagentJsonlLine } from "./cli-output-jsonl-scan.js";
import { isClaudeSubagentRecord } from "./cli-output-records.js";

/**
 * Shapes copied from a real `claude --output-format stream-json --verbose
 * --include-partial-messages` capture (Claude Code 2.1.280), with ids and text
 * replaced. The genuine records place `parent_tool_use_id` *after* the whole
 * `message` object, which is exactly the layout a top-level scan must survive.
 */
const PARENT_ASSISTANT_LINE = JSON.stringify({
  type: "assistant",
  message: {
    model: "claude-fable-5-1",
    id: "msg_parent",
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { prompt: "run it" } }],
  },
  parent_tool_use_id: null,
  session_id: "session-parent",
  uuid: "uuid-parent",
});

const SUBAGENT_LINE = JSON.stringify({
  type: "user",
  message: { role: "user", content: [{ type: "text", text: "Run the bash command" }] },
  parent_tool_use_id: "toolu_agent",
  session_id: "session-parent",
  subagent_type: "general-purpose",
});

/** A parent record whose *nested* payload carries the field. */
const PARENT_LINE_WITH_NESTED_SUBAGENT_ID = JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_agent", content: "subagent-hello" }],
  },
  tool_use_result: {
    forwarded: [{ type: "assistant", parent_tool_use_id: "toolu_agent" }],
  },
  parent_tool_use_id: null,
  session_id: "session-parent",
});

/** A parent record where the field only ever appears nested. */
const PARENT_LINE_WITH_ONLY_NESTED_ID = JSON.stringify({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    metadata: { parent_tool_use_id: "toolu_agent" },
  },
  session_id: "session-parent",
});

describe("isClaudeSubagentJsonlLine", () => {
  it("recognizes forwarded subagent traffic", () => {
    expect(isClaudeSubagentJsonlLine(SUBAGENT_LINE)).toBe(true);
  });

  it("charges a parent record that carries an explicit null parent tool id", () => {
    expect(isClaudeSubagentJsonlLine(PARENT_ASSISTANT_LINE)).toBe(false);
  });

  it("charges a parent record whose nested payload carries a subagent id", () => {
    expect(isClaudeSubagentJsonlLine(PARENT_LINE_WITH_NESTED_SUBAGENT_ID)).toBe(false);
  });

  it("charges a parent record whose only parent tool id is nested", () => {
    expect(isClaudeSubagentJsonlLine(PARENT_LINE_WITH_ONLY_NESTED_ID)).toBe(false);
  });

  it("charges a line that never mentions the field", () => {
    expect(isClaudeSubagentJsonlLine(JSON.stringify({ type: "system", subtype: "init" }))).toBe(
      false,
    );
  });

  it("charges a line whose string value merely quotes the field name", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: 'saw "parent_tool_use_id":"toolu_x" in a log' }] },
      parent_tool_use_id: null,
    });
    expect(isClaudeSubagentJsonlLine(line)).toBe(false);
  });

  it("tolerates whitespace around the top-level field", () => {
    expect(
      isClaudeSubagentJsonlLine('{ "type" : "user" , "parent_tool_use_id" : "toolu_agent" }'),
    ).toBe(true);
    expect(isClaudeSubagentJsonlLine('{ "parent_tool_use_id" : null }')).toBe(false);
  });

  it("resolves duplicate top-level keys the way JSON.parse does", () => {
    expect(
      isClaudeSubagentJsonlLine('{"parent_tool_use_id":"toolu_agent","parent_tool_use_id":null}'),
    ).toBe(false);
    expect(
      isClaudeSubagentJsonlLine('{"parent_tool_use_id":null,"parent_tool_use_id":"toolu_agent"}'),
    ).toBe(true);
  });

  it("charges anything it cannot resolve to one whole top-level object", () => {
    // Banner prefix, trailing object, and truncated JSON all decode to
    // something other than a single record; charging them is the safe verdict.
    expect(isClaudeSubagentJsonlLine(`warning: retrying\n${SUBAGENT_LINE}`)).toBe(false);
    expect(isClaudeSubagentJsonlLine(`${SUBAGENT_LINE}${PARENT_ASSISTANT_LINE}`)).toBe(false);
    expect(isClaudeSubagentJsonlLine(SUBAGENT_LINE.slice(0, -1))).toBe(false);
    expect(isClaudeSubagentJsonlLine("")).toBe(false);
  });

  it("agrees with the decoded top-level check on every single-object line", () => {
    const lines = [
      PARENT_ASSISTANT_LINE,
      SUBAGENT_LINE,
      PARENT_LINE_WITH_NESTED_SUBAGENT_ID,
      PARENT_LINE_WITH_ONLY_NESTED_ID,
      JSON.stringify({ type: "result", subtype: "success", result: "done" }),
      JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }),
      '{ "parent_tool_use_id" : "toolu_agent" }',
      '{"a":[1,2,{"parent_tool_use_id":"nested"}],"parent_tool_use_id":null}',
      '{"a":"}\\"{","parent_tool_use_id":"toolu_agent"}',
    ];
    for (const line of lines) {
      expect([line, isClaudeSubagentJsonlLine(line)]).toEqual([
        line,
        isClaudeSubagentRecord(JSON.parse(line) as Record<string, unknown>),
      ]);
    }
  });
});
