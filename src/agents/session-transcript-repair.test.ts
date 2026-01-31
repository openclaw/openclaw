import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  repairToolUseResultPairing,
  sanitizeToolUseResultPairing,
} from "./session-transcript-repair.js";

describe("sanitizeToolUseResultPairing", () => {
  it("moves tool results directly after tool calls and inserts missing results", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "read", arguments: {} },
          { type: "toolCall", id: "call_2", name: "exec", arguments: {} },
        ],
      },
      { role: "user", content: "user message that should come after tool use" },
      {
        role: "toolResult",
        toolCallId: "call_2",
        toolName: "exec",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    expect(out[0]?.role).toBe("assistant");
    expect(out[1]?.role).toBe("toolResult");
    expect((out[1] as { toolCallId?: string }).toolCallId).toBe("call_1");
    expect(out[2]?.role).toBe("toolResult");
    expect((out[2] as { toolCallId?: string }).toolCallId).toBe("call_2");
    expect(out[3]?.role).toBe("user");
  });

  it("drops duplicate tool results for the same id within a span", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "first" }],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "second" }],
        isError: false,
      },
      { role: "user", content: "ok" },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    expect(out.filter((m) => m.role === "toolResult")).toHaveLength(1);
  });

  it("drops duplicate tool results for the same id across the transcript", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "first" }],
        isError: false,
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "second (duplicate)" }],
        isError: false,
      },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    const results = out.filter((m) => m.role === "toolResult") as Array<{
      toolCallId?: string;
    }>;
    expect(results).toHaveLength(1);
    expect(results[0]?.toolCallId).toBe("call_1");
  });

  it("drops orphan tool results that do not match any tool call", () => {
    const input = [
      { role: "user", content: "hello" },
      {
        role: "toolResult",
        toolCallId: "call_orphan",
        toolName: "read",
        content: [{ type: "text", text: "orphan" }],
        isError: false,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    expect(out.some((m) => m.role === "toolResult")).toBe(false);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("repairToolUseResultPairing malformed tool_use stripping", () => {
  // Reproduces the root cause of issues #5497, #5481, #5430, #5518:
  // Malformed tool_use blocks (from interrupted tool calls) cause API rejections:
  // - "unexpected tool_use_id found in tool_result blocks"
  // - "tool result's tool id not found (2013)"
  // The fix: strip malformed blocks before pairing repair runs.

  it("strips tool_use blocks with missing id", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", name: "read", arguments: {} },
          { type: "text", text: "hello" },
        ],
      },
    ] as AgentMessage[];

    const report = repairToolUseResultPairing(input);
    expect(report.droppedMalformedToolUseCount).toBe(1);
    const assistantContent = (report.messages[0] as { content?: unknown[] }).content;
    expect(assistantContent).toHaveLength(1);
    expect((assistantContent![0] as { type: string }).type).toBe("text");
  });

  it("strips tool_use blocks with empty string id", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "", name: "read", arguments: {} },
          { type: "text", text: "ok" },
        ],
      },
    ] as AgentMessage[];

    const report = repairToolUseResultPairing(input);
    expect(report.droppedMalformedToolUseCount).toBe(1);
    const assistantContent = (report.messages[0] as { content?: unknown[] }).content;
    expect(assistantContent).toHaveLength(1);
  });

  it("strips tool_use blocks with partialJson field", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "read", arguments: {}, partialJson: '{"foo":' },
          { type: "text", text: "done" },
        ],
      },
    ] as AgentMessage[];

    const report = repairToolUseResultPairing(input);
    expect(report.droppedMalformedToolUseCount).toBe(1);
    const assistantContent = (report.messages[0] as { content?: unknown[] }).content;
    expect(assistantContent).toHaveLength(1);
    expect((assistantContent![0] as { type: string }).type).toBe("text");
  });

  it("tolerates tool_use blocks with missing name (repaired via synthetic result)", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", arguments: {} }, // missing name is ok
          { type: "text", text: "ok" },
        ],
      },
    ] as AgentMessage[];

    const report = repairToolUseResultPairing(input);
    expect(report.droppedMalformedToolUseCount).toBe(0);
    // Missing name triggers synthetic result insertion
    expect(report.added).toHaveLength(1);
  });

  it("keeps valid blocks while stripping malformed ones", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_valid", name: "read", arguments: {} },
          { type: "toolCall", id: "", name: "write", arguments: {} }, // malformed: empty id
          { type: "text", text: "text block" },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_valid",
        toolName: "read",
        content: [{ type: "text", text: "result" }],
        isError: false,
      },
    ] as AgentMessage[];

    const report = repairToolUseResultPairing(input);
    expect(report.droppedMalformedToolUseCount).toBe(1);
    const assistantContent = (report.messages[0] as { content?: unknown[] }).content;
    expect(assistantContent).toHaveLength(2); // valid toolCall + text
    expect((assistantContent![0] as { id?: string }).id).toBe("call_valid");
    // Should not create synthetic result for the stripped malformed block
    expect(report.added).toHaveLength(0);
  });

  it("preserves assistant messages with empty content after stripping all tool blocks", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", arguments: {} }], // missing id
        stopReason: "tool_use", // non-error stopReason to verify we preserve any metadata
      },
    ] as AgentMessage[];

    const report = repairToolUseResultPairing(input);
    expect(report.droppedMalformedToolUseCount).toBe(1);
    expect(report.messages).toHaveLength(1);
    // Message preserved with metadata intact
    expect((report.messages[0] as { stopReason?: string }).stopReason).toBe("tool_use");
    expect((report.messages[0] as { content?: unknown[] }).content).toHaveLength(0);
  });

  it("does not create synthetic results for stripped malformed blocks", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", name: "read", arguments: {} }, // malformed: no id
        ],
      },
    ] as AgentMessage[];

    const report = repairToolUseResultPairing(input);
    expect(report.droppedMalformedToolUseCount).toBe(1);
    expect(report.added).toHaveLength(0);
  });

  it("report includes droppedMalformedToolUseCount", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ] as AgentMessage[];

    const report = repairToolUseResultPairing(input);
    expect(report).toHaveProperty("droppedMalformedToolUseCount");
    expect(report.droppedMalformedToolUseCount).toBe(0);
  });

  it("recovers from interrupted tool call (session corruption scenario)", () => {
    // This simulates the exact scenario from issues #5497, #5481, #5430, #5518:
    // A tool call is interrupted mid-stream (error, timeout, content filtering, or process death).
    // The session file contains a malformed tool_use block with no id.
    // Without the fix, every subsequent API request fails because the API expects
    // a matching tool_result for every tool_use, but we can't provide one for an id-less block.
    const corruptedSession = [
      { role: "user", content: "read file.txt" },
      {
        role: "assistant",
        content: [
          // Interrupted tool call - no id assigned before the stream was cut
          { type: "toolCall", name: "read", arguments: {} },
        ],
        stopReason: "error",
      },
      // User tries again after the error
      { role: "user", content: "try again" },
    ] as AgentMessage[];

    const report = repairToolUseResultPairing(corruptedSession);

    // The malformed tool_use block should be stripped
    expect(report.droppedMalformedToolUseCount).toBe(1);
    // No synthetic results should be created for the stripped block
    expect(report.added).toHaveLength(0);
    // Session should be usable again: user, (empty) assistant with error, user
    expect(report.messages).toHaveLength(3);
    expect(report.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    // The error assistant message is preserved (with empty content) for debugging
    const errorAssistant = report.messages[1] as { stopReason?: string; content?: unknown[] };
    expect(errorAssistant.stopReason).toBe("error");
    expect(errorAssistant.content).toHaveLength(0);
  });
});
