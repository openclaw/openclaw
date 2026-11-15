import { describe, expect, it } from "vitest";
import { chargeClaudeStreamJsonLine } from "./cli-output-stream-limits.js";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";

describe("discarded child budget boundaries", () => {
  it("discounts semantic assistant and user child records only", () => {
    const assistant = {
      type: "assistant",
      parent_tool_use_id: "child",
      message: { content: [{ type: "text", text: "x".repeat(1000) }] },
    };
    const user = {
      type: "user",
      parent_tool_use_id: "child",
      message: { content: [{ type: "tool_result", content: "x".repeat(1000) }] },
    };
    for (const record of [assistant, user]) {
      expect(chargeClaudeStreamJsonLine(record, JSON.stringify(record)).chars).toBe(64);
    }
    const charged = [
      { ...assistant, parent_tool_use_id: "x".repeat(129) },
      { ...assistant, parent_tool_use_id: " " },
      { ...assistant, parent_tool_use_id: null },
      { ...assistant, item: {} },
      { ...assistant, message: { content: [] } },
      { ...user, message: { content: [{ type: "text", text: "not a result" }] } },
      { type: "system", parent_tool_use_id: "child", data: "x".repeat(1000) },
    ];
    for (const record of charged) {
      const raw = JSON.stringify(record);
      expect(chargeClaudeStreamJsonLine(record, raw).chars).toBe(raw.length);
    }
  });
  it("does not discount ambiguous multi-record or malformed lines", () => {
    const raw = "x".repeat(1000);
    expect(chargeClaudeStreamJsonLine(undefined, raw).chars).toBe(raw.length);
  });
  it("rejects an individual oversized discarded child line before discounting", () => {
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
    });
    parser.push(
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: "child",
        message: { content: [{ type: "text", text: "x".repeat(8 * 1024 * 1024) }] },
      }) + String.fromCharCode(10),
    );
    parser.finish();
    expect(parser.getErrorText()).toMatch(/8388608/);
  });
});
