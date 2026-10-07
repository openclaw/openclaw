import { describe, expect, it } from "vitest";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";

const SESSION_ID = "22222222-2222-4222-8222-222222222222";

function createParser(onToolResult?: (result: unknown) => void) {
  return createCliJsonlStreamingParser({
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    providerId: "claude-cli",
    onAssistantDelta: () => {},
    onToolResult: onToolResult ? (delta) => onToolResult(delta.result) : undefined,
  });
}

function streamEvent(event: Record<string, unknown>) {
  return { type: "stream_event", event, session_id: SESSION_ID, parent_tool_use_id: null };
}

// Claude Code echoes each tool result twice: in `message.content` and in `tool_use_result`.
function toolResultRecord(id: string, output: string) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: output, is_error: false }],
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: "33333333-3333-4333-8333-333333333333",
    tool_use_result: { stdout: output, stderr: "", interrupted: false, isImage: false },
  };
}

describe("Claude tool-result output budgets", () => {
  it("delivers the final reply after many large tool results", () => {
    const parser = createParser();
    const push = (record: unknown) => parser.push(`${JSON.stringify(record)}\n`);
    const output = "x".repeat(120_000);
    let wireChars = 0;
    push({ type: "system", subtype: "init", session_id: SESSION_ID, tools: ["Bash"] });
    for (let index = 0; index < 40; index += 1) {
      const id = `toolu_${String(index).padStart(4, "0")}`;
      const input = { command: `cat log-${index}.txt` };
      const tool = { type: "tool_use", id, name: "Bash", input };
      push(streamEvent({ type: "message_start", message: { id: `msg_${index}` } }));
      push(
        streamEvent({
          type: "content_block_start",
          index: 0,
          content_block: { ...tool, input: {} },
        }),
      );
      push(
        streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
        }),
      );
      push(streamEvent({ type: "content_block_stop", index: 0 }));
      push({ type: "assistant", message: { id: `msg_${index}`, content: [tool] } });
      const line = `${JSON.stringify(toolResultRecord(id, output))}\n`;
      wireChars += line.length;
      parser.push(line);
    }
    push({
      type: "assistant",
      message: { id: "msg_final", content: [{ type: "text", text: "done" }] },
    });
    push({ type: "result", subtype: "success", result: "done", session_id: SESSION_ID });
    parser.finish();

    expect(wireChars).toBeGreaterThan(8 * 1024 * 1024);
    expect(parser.getErrorText()).toBeNull();
    expect(parser.hasTerminalResult()).toBe(true);
    expect(parser.getOutput()?.text).toBe("done");
  });

  it("hands every large tool result to consumers unchanged", () => {
    const results: unknown[] = [];
    const parser = createParser((result) => results.push(result));
    const output = "y".repeat(2_000_000);
    for (let index = 0; index < 5; index += 1) {
      parser.push(`${JSON.stringify(toolResultRecord(`toolu_${index}`, output))}\n`);
    }
    parser.finish();
    expect(parser.getErrorText()).toBeNull();
    expect(results).toEqual(Array.from({ length: 5 }, () => output));
  });

  it("still charges what the parser keeps from tool-result records", () => {
    const parser = createParser();
    const id = "i".repeat(3_000_000);
    for (let index = 0; index < 3; index += 1) {
      parser.push(`${JSON.stringify(toolResultRecord(`${id}${index}`, ""))}\n`);
    }
    expect(parser.getErrorText()).toContain("exceeded 8388608 characters");
  });

  it("still charges whitespace padding on tool-result records", () => {
    const parser = createParser();
    const line = `${JSON.stringify(toolResultRecord("toolu_pad", "ok"))}${" ".repeat(4_300_000)}\n`;
    parser.push(line);
    expect(parser.getErrorText()).toBeNull();
    parser.push(line);
    expect(parser.getErrorText()).toContain("exceeded 8388608 characters");
  });

  it("charges user records that mix tool results with other content in full", () => {
    const parser = createParser();
    const line = (index: number) => {
      const record = toolResultRecord(`toolu_mixed_${index}`, "z".repeat(1_500_000));
      record.message.content.push({ type: "text", text: "note" } as never);
      return `${JSON.stringify(record)}\n`;
    };
    // Each line stays under the 8 MiB line limit; together they exceed the turn budget.
    expect(line(0).length).toBeLessThan(4 * 1024 * 1024);
    for (let index = 0; index < 3; index += 1) {
      parser.push(line(index));
    }
    expect(parser.getErrorText()).toBe(
      "CLI JSONL output exceeded 8388608 characters; refusing to parse output.",
    );
  });

  it("charges IDs and padding even when payload numbers re-encode longer than the wire", () => {
    // `1e20` is 4 characters on the wire but re-encodes as 21 digits.
    const numbers = `[${Array.from({ length: 200_000 }, () => "1e20").join(",")}]`;
    const line = (id: string, padding = "") =>
      `{"type":"user","message":{"role":"user","content":[{"type":"tool_result",` +
      `"tool_use_id":"${id}","content":""}]},` +
      `"session_id":"${SESSION_ID}","tool_use_result":${numbers}}${padding}\n`;
    const budgetError = "CLI JSONL output exceeded 8388608 characters; refusing to parse output.";

    const idParser = createParser();
    const longId = "i".repeat(3_000_000);
    expect(line(longId).length).toBeLessThan(4_100_000);
    for (let index = 0; index < 3; index += 1) {
      idParser.push(line(`${longId}${index}`));
    }
    expect(idParser.getErrorText()).toBe(budgetError);

    const paddingParser = createParser();
    const padded = line("toolu_pad", " ".repeat(4_300_000));
    expect(padded.length).toBeLessThan(5_400_000);
    paddingParser.push(padded);
    expect(paddingParser.getErrorText()).toBeNull();
    paddingParser.push(padded);
    expect(paddingParser.getErrorText()).toBe(budgetError);
  });

  it("keeps tool-result records under the ordinary frame limit", () => {
    const parser = createParser();
    const line = `${JSON.stringify(toolResultRecord("toolu_same", "ok"))}\n`;
    parser.push(line.repeat(20_001));
    expect(parser.getErrorText()).toContain("exceeded 20000 lines");
  });
});
