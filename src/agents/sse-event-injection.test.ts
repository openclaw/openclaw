import { describe, expect, it } from "vitest";
import {
  type SseInjectionState,
  processChunk,
  sanitizeSseEventName,
} from "./sse-event-injection.js";

/**
 * Tests for the SSE event field injection fix.
 * @see https://github.com/openclaw/openclaw/issues/37571
 */

function freshState(): SseInjectionState {
  return { prevWasEvent: false };
}

describe("sanitizeSseEventName", () => {
  it("passes through normal event names", () => {
    expect(sanitizeSseEventName("message_start")).toBe("message_start");
    expect(sanitizeSseEventName("content_block_delta")).toBe("content_block_delta");
  });

  it("strips CR/LF and control characters", () => {
    expect(sanitizeSseEventName("foo\r\nbar")).toBe("foobar");
    expect(sanitizeSseEventName("foo\x00bar")).toBe("foobar");
  });

  it("returns null for empty or control-only strings", () => {
    expect(sanitizeSseEventName("")).toBeNull();
    expect(sanitizeSseEventName("\r\n")).toBeNull();
  });
});

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

    const output = processChunk(input, freshState());
    const lines = output.split("\n");

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

    const output = processChunk(input, freshState());

    expect(output.match(/event: message_start/g)).toHaveLength(1);
    expect(output.match(/event: content_block_delta/g)).toHaveLength(1);
  });

  it("handles data: lines with non-JSON content gracefully", () => {
    const input = ["data: [DONE]", "", "data: not json", ""].join("\n");

    const output = processChunk(input, freshState());

    expect(output).not.toContain("event:");
    expect(output).toContain("data: [DONE]");
    expect(output).toContain("data: not json");
  });

  it("handles data: lines without a type field", () => {
    const input = ['data: {"id":"msg_1","role":"assistant"}', ""].join("\n");

    const output = processChunk(input, freshState());

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

    const output = processChunk(input, freshState());

    expect(output.match(/event: message_start/g)).toHaveLength(1);
    expect(output).toContain("event: content_block_start");
  });

  it("preserves empty lines between SSE events", () => {
    const input = [
      'data: {"type":"message_start","message":{"id":"msg_1"}}',
      "",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");

    const output = processChunk(input, freshState());

    expect(output).toContain("\n\n");
  });

  it("carries prevWasEvent state across chunk boundaries", () => {
    const state = freshState();

    // First chunk ends with an event: line
    const chunk1 = "event: message_start\n";
    processChunk(chunk1, state);
    expect(state.prevWasEvent).toBe(true);

    // Second chunk starts with the corresponding data: line
    const chunk2 = 'data: {"type":"message_start","message":{"id":"msg_1"}}\n\n';
    const output2 = processChunk(chunk2, state);

    // Should NOT inject a duplicate event: line
    expect(output2).not.toContain("event:");
    expect(output2).toContain("data:");
  });

  it("resets state on empty line (dispatch boundary) across chunks", () => {
    const state = freshState();

    // First chunk: event + data + empty dispatch boundary
    const chunk1 = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"msg_1"}}',
      "",
      "",
    ].join("\n");
    processChunk(chunk1, state);
    expect(state.prevWasEvent).toBe(false);

    // Second chunk: data without event (should inject)
    const chunk2 = 'data: {"type":"content_block_start","index":0}\n\n';
    const output2 = processChunk(chunk2, state);
    expect(output2).toContain("event: content_block_start");
  });

  it("sanitizes event names with CRLF injection (CWE-93)", () => {
    const input = 'data: {"type":"foo\\r\\nid:evil"}\n\n';

    const output = processChunk(input, freshState());

    // The injected event name should have control chars stripped
    expect(output).toContain("event: fooid:evil");
    expect(output).not.toContain("event: foo\r");
    expect(output).not.toContain("event: foo\n");
  });

  it("drops event injection when type is only control characters", () => {
    const input = 'data: {"type":"\\r\\n"}\n\n';
    const output = processChunk(input, freshState());
    expect(output).not.toContain("event:");
  });

  it("does not reset prevWasEvent on intermediate SSE fields (id:, retry:)", () => {
    const state = freshState();

    // event: line followed by id: field followed by data: line
    const input = [
      "event: message_start",
      "id: 123",
      'data: {"type":"message_start","message":{"id":"msg_1"}}',
      "",
    ].join("\n");

    const output = processChunk(input, state);

    // Should NOT inject a second event: line — the id: field should not reset state
    expect(output.match(/event: message_start/g)).toHaveLength(1);
  });
});
