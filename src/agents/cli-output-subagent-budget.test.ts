import { describe, expect, it } from "vitest";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";

const AGENT_CALL = "agent-call-1";

function createParser(onProgress?: (id: string) => void) {
  return createCliJsonlStreamingParser({
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    providerId: "claude-cli",
    onAssistantDelta: () => {},
    onAttributedSubagentProgress: onProgress,
  });
}

function runTurn(parentToolUseId: string | null, records: number, chars: number) {
  const progress: string[] = [];
  const parser = createParser((id) => progress.push(id));
  const push = (record: unknown) => parser.push(`${JSON.stringify(record)}\n`);
  const agentCall = {
    type: "tool_use",
    id: AGENT_CALL,
    name: "Agent",
    input: { prompt: "research" },
  };
  push({ type: "assistant", message: { id: "parent-call", content: [agentCall] } });
  for (let index = 0; index < records; index += 1) {
    push({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: `sub-${index}`, content: "r".repeat(chars) }],
      },
      parent_tool_use_id: parentToolUseId,
    });
  }
  push({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: AGENT_CALL, content: "findings" }] },
  });
  push({
    type: "assistant",
    message: { id: "final-message", content: [{ type: "text", text: "completed" }] },
  });
  push({ type: "result", subtype: "success", result: "completed" });
  parser.finish();
  return { parser, progress };
}

describe("Claude subagent output budget", () => {
  it("keeps the parent reply after subagent traffic far beyond the raw limit", () => {
    // 12 MiB of forwarded subagent tool results, which the parser never keeps.
    const { parser, progress } = runTurn(AGENT_CALL, 300, 40 * 1024);
    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()?.text).toBe("completed");
    expect(progress.length).toBe(300);
    expect(new Set(progress)).toEqual(new Set([AGENT_CALL]));
  });

  it("still bounds the same volume in the parent conversation", () => {
    const { parser } = runTurn(null, 300, 40 * 1024);
    expect(parser.getErrorText()).toMatch(/exceeded 8388608 characters/);
    expect(parser.getOutput()?.text).toBe("");
  });

  it("still bounds a subagent flood by frames", () => {
    const { parser } = runTurn(AGENT_CALL, 20_001, 1);
    expect(parser.getErrorText()).toMatch(/exceeded 20000 lines/);
  });
});
