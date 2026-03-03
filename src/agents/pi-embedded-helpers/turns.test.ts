import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { validateAnthropicTurns, validateGeminiTurns, validateMistralTurns } from "./turns.js";

// Helper to create typed messages
function userMsg(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] } as AgentMessage;
}

function assistantMsg(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }] } as AgentMessage;
}

function toolMsg(toolCallId: string, text: string): AgentMessage {
  return {
    role: "tool",
    toolCallId,
    toolName: "test_tool",
    isError: false,
    timestamp: Date.now(),
    content: [{ type: "text", text }],
  } as AgentMessage;
}

describe("validateMistralTurns", () => {
  it("returns empty array for empty input", () => {
    expect(validateMistralTurns([])).toEqual([]);
  });

  it("returns input unchanged when no tool→user sequence exists", () => {
    const messages = [userMsg("hello"), assistantMsg("hi"), userMsg("bye")];
    expect(validateMistralTurns(messages)).toEqual(messages);
  });

  it("inserts synthetic assistant message between tool and user", () => {
    const messages = [assistantMsg("calling tool"), toolMsg("call_1", "result"), userMsg("thanks")];
    const result = validateMistralTurns(messages);
    expect(result).toHaveLength(4);
    expect((result[0] as { role: string }).role).toBe("assistant");
    expect((result[1] as { role: string }).role).toBe("tool");
    expect((result[2] as { role: string }).role).toBe("assistant");
    expect((result[3] as { role: string }).role).toBe("user");
    // Verify the synthetic message content
    const synthetic = result[2] as { role: string; content: Array<{ type: string; text: string }> };
    expect(synthetic.content[0].text).toBe("(continuing)");
  });

  it("handles multiple consecutive tool messages before user", () => {
    const messages = [
      assistantMsg("calling tools"),
      toolMsg("call_1", "result 1"),
      toolMsg("call_2", "result 2"),
      userMsg("got it"),
    ];
    const result = validateMistralTurns(messages);
    // Only the last tool→user boundary needs a bridge
    expect(result).toHaveLength(5);
    expect((result[0] as { role: string }).role).toBe("assistant");
    expect((result[1] as { role: string }).role).toBe("tool");
    expect((result[2] as { role: string }).role).toBe("tool");
    expect((result[3] as { role: string }).role).toBe("assistant"); // synthetic bridge
    expect((result[4] as { role: string }).role).toBe("user");
  });

  it("handles tool→assistant sequence without modification", () => {
    const messages = [
      assistantMsg("calling tool"),
      toolMsg("call_1", "result"),
      assistantMsg("done"),
    ];
    const result = validateMistralTurns(messages);
    expect(result).toEqual(messages);
    expect(result).toHaveLength(3);
  });

  it("handles multiple tool→user transitions", () => {
    const messages = [
      assistantMsg("first call"),
      toolMsg("call_1", "result 1"),
      userMsg("ok continue"),
      assistantMsg("second call"),
      toolMsg("call_2", "result 2"),
      userMsg("done"),
    ];
    const result = validateMistralTurns(messages);
    expect(result).toHaveLength(8); // 2 synthetic messages inserted
    // Check both bridge insertions
    expect((result[2] as { role: string }).role).toBe("assistant"); // bridge 1
    expect((result[3] as { role: string }).role).toBe("user");
    expect((result[6] as { role: string }).role).toBe("assistant"); // bridge 2
    expect((result[7] as { role: string }).role).toBe("user");
  });

  it("does not modify user→user or assistant→assistant sequences", () => {
    const messages = [userMsg("a"), userMsg("b"), assistantMsg("c")];
    const result = validateMistralTurns(messages);
    expect(result).toEqual(messages);
  });
});

describe("validateGeminiTurns", () => {
  it("merges consecutive assistant messages", () => {
    const messages = [userMsg("hello"), assistantMsg("part 1"), assistantMsg("part 2")];
    const result = validateGeminiTurns(messages);
    expect(result).toHaveLength(2);
    expect((result[0] as { role: string }).role).toBe("user");
    expect((result[1] as { role: string }).role).toBe("assistant");
  });
});

describe("validateAnthropicTurns", () => {
  it("merges consecutive user messages", () => {
    const messages = [userMsg("part 1"), userMsg("part 2"), assistantMsg("response")];
    const result = validateAnthropicTurns(messages);
    expect(result).toHaveLength(2);
    expect((result[0] as { role: string }).role).toBe("user");
    expect((result[1] as { role: string }).role).toBe("assistant");
  });
});
