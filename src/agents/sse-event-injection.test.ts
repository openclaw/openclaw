import { describe, expect, it } from "vitest";

/**
 * Tests for the SSE event field injection fix applied via pnpm patch to
 * `@mariozechner/pi-ai`. The patch injects `event:` lines into SSE streams
 * from proxies that omit them, which is required by the `@anthropic-ai/sdk`
 * SSE parser.
 *
 * These tests import the patched `processChunk` logic inline to verify
 * correctness without requiring a live HTTP server.
 */

// Inline the processChunk function from the patch for unit testing
function processChunk(chunk: string): string {
  const lines = chunk.split(/\r?\n|\r/);
  const result: string[] = [];
  let prevWasEvent = false;
  for (const line of lines) {
    if (line.startsWith("event:")) {
      prevWasEvent = true;
      result.push(line);
      continue;
    }
    if (line.startsWith("data:") && !prevWasEvent) {
      const jsonStr = line.slice(5).trim();
      if (jsonStr) {
        try {
          const parsed = JSON.parse(jsonStr);
          if (parsed && typeof parsed.type === "string") {
            result.push("event: " + parsed.type);
          }
        } catch {
          // Not valid JSON — leave as-is, no event injection
        }
      }
    }
    prevWasEvent = false;
    result.push(line);
  }
  return result.join("\n");
}

describe("SSE event injection (issue #37571)", () => {
  it("injects event: lines when missing from data-only SSE stream", () => {
    const input = [
      'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant"}}',
      "",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      "",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      "",
      'data: {"type":"content_block_stop","index":0}',
      "",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
      "",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");

    const output = processChunk(input);
    const lines = output.split("\n");

    // Each data: line should now be preceded by an event: line
    expect(lines).toContain("event: message_start");
    expect(lines).toContain("event: content_block_start");
    expect(lines).toContain("event: content_block_delta");
    expect(lines).toContain("event: content_block_stop");
    expect(lines).toContain("event: message_delta");
    expect(lines).toContain("event: message_stop");
  });

  it("does not double-inject when event: lines already present", () => {
    const input = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"msg_1"}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      "",
    ].join("\n");

    const output = processChunk(input);

    // Count occurrences of "event: message_start"
    const matches = output.match(/event: message_start/g);
    expect(matches).toHaveLength(1);

    const deltaMatches = output.match(/event: content_block_delta/g);
    expect(deltaMatches).toHaveLength(1);
  });

  it("handles data: lines with non-JSON content gracefully", () => {
    const input = ["data: [DONE]", "", "data: not json", ""].join("\n");

    const output = processChunk(input);

    // Should not crash and should not inject event lines
    expect(output).not.toContain("event:");
    expect(output).toContain("data: [DONE]");
    expect(output).toContain("data: not json");
  });

  it("handles data: lines without a type field", () => {
    const input = ['data: {"id":"msg_1","role":"assistant"}', ""].join("\n");

    const output = processChunk(input);

    // No type field -> no event injection
    expect(output).not.toContain("event:");
  });

  it("handles mixed stream with some event: lines present", () => {
    const input = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"msg_1"}}',
      "",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      "",
    ].join("\n");

    const output = processChunk(input);
    const lines = output.split("\n");

    // message_start should appear only once (from original)
    const msgStartMatches = output.match(/event: message_start/g);
    expect(msgStartMatches).toHaveLength(1);

    // content_block_start should be injected
    expect(lines).toContain("event: content_block_start");
  });

  it("preserves empty lines between SSE events", () => {
    const input = [
      'data: {"type":"message_start","message":{"id":"msg_1"}}',
      "",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");

    const output = processChunk(input);

    // Should still have empty separator lines
    expect(output).toContain("\n\n");
  });
});
