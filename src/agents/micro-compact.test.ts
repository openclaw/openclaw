import { describe, expect, it } from "vitest";
import {
  CLEARED_TOOL_RESULT_PLACEHOLDER,
  DEFAULT_RECENT_TOOL_RESULTS_PRESERVE,
  microCompactMessages,
} from "./micro-compact.js";
import { castAgentMessage } from "./test-helpers/agent-message-fixtures.js";

function toolResult(toolName: string, text: string, isError = false) {
  return castAgentMessage({
    role: "toolResult",
    toolCallId: `tc-${toolName}-${Math.random().toString(36).slice(2, 6)}`,
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp: 0,
  });
}

function userMsg(text: string) {
  return castAgentMessage({ role: "user", content: text, timestamp: 0 });
}

function assistantMsg(text: string) {
  return castAgentMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 0,
  });
}

describe("microCompactMessages", () => {
  it("returns messages unchanged when there are fewer clearable results than the preserve limit", () => {
    const messages = [
      userMsg("hello"),
      assistantMsg("hi"),
      toolResult("read", "file contents here"),
      toolResult("exec", "command output"),
    ];
    const result = microCompactMessages(messages);
    expect(result).toEqual(messages);
  });

  it("clears old clearable tool results beyond the preserve count", () => {
    const messages = [
      toolResult("read", "old file 1"),
      toolResult("read", "old file 2"),
      toolResult("exec", "old exec output"),
      toolResult("write", "old write output"),
      toolResult("edit", "old edit output"),
      toolResult("bash", "old bash output"),
      // These are the last 5 and should be preserved
      toolResult("read", "recent file 1"),
      toolResult("exec", "recent exec"),
      toolResult("browser", "recent browser"),
      toolResult("web_search", "recent search"),
      toolResult("web_fetch", "recent fetch"),
    ];
    const result = microCompactMessages(messages);

    // First 6 should be cleared
    for (let i = 0; i < 6; i++) {
      const content = (result[i] as { content: unknown }).content;
      expect(content).toEqual([{ type: "text", text: CLEARED_TOOL_RESULT_PLACEHOLDER }]);
    }
    // Last 5 should be preserved
    for (let i = 6; i < 11; i++) {
      expect(result[i]).toEqual(messages[i]);
    }
  });

  it("preserves non-clearable tool results regardless of position", () => {
    const messages = [
      toolResult("read", "old file"),
      toolResult("custom_tool", "custom output"),
      toolResult("read", "another old file"),
      toolResult("read", "recent 1"),
      toolResult("read", "recent 2"),
      toolResult("read", "recent 3"),
      toolResult("read", "recent 4"),
      toolResult("read", "recent 5"),
    ];
    const result = microCompactMessages(messages);

    // First "read" should be cleared (7 clearable total, preserve 5, so 2 get cleared)
    const firstContent = (result[0] as { content: unknown }).content;
    expect(firstContent).toEqual([{ type: "text", text: CLEARED_TOOL_RESULT_PLACEHOLDER }]);
    // "custom_tool" is not clearable, should remain unchanged
    expect(result[1]).toEqual(messages[1]);
    // Third "read" should also be cleared (it's the 2nd clearable result of 7)
    const thirdContent = (result[2] as { content: unknown }).content;
    expect(thirdContent).toEqual([{ type: "text", text: CLEARED_TOOL_RESULT_PLACEHOLDER }]);
  });

  it("never clears error tool results", () => {
    const messages = [
      toolResult("read", "error output", true),
      toolResult("exec", "another error", true),
      toolResult("read", "recent 1"),
      toolResult("read", "recent 2"),
      toolResult("read", "recent 3"),
      toolResult("read", "recent 4"),
      toolResult("read", "recent 5"),
    ];
    const result = microCompactMessages(messages);

    // Error results should be kept intact
    expect(result[0]).toEqual(messages[0]);
    expect(result[1]).toEqual(messages[1]);
  });

  it("preserves user and assistant messages", () => {
    const messages = [
      userMsg("please read file"),
      assistantMsg("reading it now"),
      toolResult("read", "old file content"),
      userMsg("now read another"),
      assistantMsg("sure"),
      toolResult("read", "recent 1"),
      toolResult("read", "recent 2"),
      toolResult("read", "recent 3"),
      toolResult("read", "recent 4"),
      toolResult("read", "recent 5"),
    ];
    const result = microCompactMessages(messages);

    // User and assistant messages unchanged
    expect(result[0]).toEqual(messages[0]);
    expect(result[1]).toEqual(messages[1]);
    expect(result[3]).toEqual(messages[3]);
    expect(result[4]).toEqual(messages[4]);
    // Old read should be cleared
    const readContent = (result[2] as { content: unknown }).content;
    expect(readContent).toEqual([{ type: "text", text: CLEARED_TOOL_RESULT_PLACEHOLDER }]);
  });

  it("respects custom preserve count", () => {
    const messages = [
      toolResult("read", "file 1"),
      toolResult("read", "file 2"),
      toolResult("read", "file 3"),
    ];

    // Preserve only 1
    const result = microCompactMessages(messages, 1);
    const first = (result[0] as { content: unknown }).content;
    const second = (result[1] as { content: unknown }).content;
    expect(first).toEqual([{ type: "text", text: CLEARED_TOOL_RESULT_PLACEHOLDER }]);
    expect(second).toEqual([{ type: "text", text: CLEARED_TOOL_RESULT_PLACEHOLDER }]);
    // Last one preserved
    expect(result[2]).toEqual(messages[2]);
  });

  it("clears all clearable results when preserve count is 0", () => {
    const messages = [toolResult("read", "file 1"), toolResult("exec", "output")];
    const result = microCompactMessages(messages, 0);
    for (const msg of result) {
      const content = (msg as { content: unknown }).content;
      expect(content).toEqual([{ type: "text", text: CLEARED_TOOL_RESULT_PLACEHOLDER }]);
    }
  });

  it("handles empty messages array", () => {
    expect(microCompactMessages([])).toEqual([]);
  });

  it("preserves toolCallId, toolName, and other metadata on cleared results", () => {
    const messages = [
      toolResult("read", "old content"),
      toolResult("read", "recent 1"),
      toolResult("read", "recent 2"),
      toolResult("read", "recent 3"),
      toolResult("read", "recent 4"),
      toolResult("read", "recent 5"),
    ];
    const result = microCompactMessages(messages);
    const cleared = result[0] as { role: string; toolCallId: string; toolName: string };
    const original = messages[0] as { role: string; toolCallId: string; toolName: string };

    expect(cleared.role).toBe("toolResult");
    expect(cleared.toolCallId).toBe(original.toolCallId);
    expect(cleared.toolName).toBe("read");
  });

  it("targets all expected clearable tool names", () => {
    const clearableNames = [
      "read",
      "write",
      "edit",
      "exec",
      "bash",
      "shell",
      "web_search",
      "web_fetch",
      "browser",
    ];
    // Create enough messages to exceed preserve limit
    const messages = clearableNames.map((name) => toolResult(name, `${name} output`));
    // Add extra to push past preserve limit
    for (let i = 0; i < DEFAULT_RECENT_TOOL_RESULTS_PRESERVE; i++) {
      messages.push(toolResult("read", `filler ${i}`));
    }

    const result = microCompactMessages(messages);
    // The first batch (clearableNames.length minus any within preserve window) should be cleared
    const clearCount =
      clearableNames.length +
      DEFAULT_RECENT_TOOL_RESULTS_PRESERVE -
      DEFAULT_RECENT_TOOL_RESULTS_PRESERVE;
    for (let i = 0; i < clearCount; i++) {
      const content = (result[i] as { content: unknown }).content;
      expect(content).toEqual([{ type: "text", text: CLEARED_TOOL_RESULT_PLACEHOLDER }]);
    }
  });

  it("does not clear tool results with unrecognized tool names", () => {
    const messages = [
      toolResult("custom_tool", "custom output"),
      toolResult("another_tool", "another output"),
      toolResult("read", "recent 1"),
    ];
    const result = microCompactMessages(messages);
    // Custom tools should be untouched
    expect(result[0]).toEqual(messages[0]);
    expect(result[1]).toEqual(messages[1]);
  });
});
