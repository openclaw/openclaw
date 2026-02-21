import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { repairToolUseResultPairing } from "./session-transcript-repair.js";

function assistantToolCall(id: string, opts?: { stopReason?: string }): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "exec", arguments: { command: "ls" } }],
    stopReason: opts?.stopReason,
  } as unknown as AgentMessage;
}

function toolResult(id: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "exec",
    content: [{ type: "text", text: "result" }],
  } as unknown as AgentMessage;
}

function textAssistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

describe("repairToolUseResultPairing — aborted message tool_use stripping (#16823)", () => {
  it("strips tool_use blocks from aborted assistant messages", () => {
    const messages: AgentMessage[] = [
      assistantToolCall("call_1", { stopReason: "aborted" }),
      textAssistant("follow-up"),
    ];
    const report = repairToolUseResultPairing(messages);
    // The aborted message's tool_use should be stripped
    const roles = report.messages.map((m) => m.role);
    expect(roles).not.toContain("toolResult"); // no synthetic results
    // The aborted assistant message should either be gone or have no tool_use
    for (const msg of report.messages) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const hasToolCall = msg.content.some(
          (b: unknown) =>
            b &&
            typeof b === "object" &&
            ((b as { type?: string }).type === "toolCall" ||
              (b as { type?: string }).type === "toolUse"),
        );
        if ((msg as { stopReason?: string }).stopReason === "aborted") {
          expect(hasToolCall).toBe(false);
        }
      }
    }
  });

  it("strips tool_use blocks from errored assistant messages", () => {
    const messages: AgentMessage[] = [
      assistantToolCall("call_1", { stopReason: "error" }),
      textAssistant("recovery"),
    ];
    const report = repairToolUseResultPairing(messages);
    const roles = report.messages.map((m) => m.role);
    expect(roles).not.toContain("toolResult");
  });

  it("preserves normal assistant tool_use/result pairing", () => {
    const messages: AgentMessage[] = [
      assistantToolCall("call_1"),
      toolResult("call_1"),
      textAssistant("done"),
    ];
    const report = repairToolUseResultPairing(messages);
    expect(report.messages.map((m) => m.role)).toEqual(["assistant", "toolResult", "assistant"]);
    expect(report.added).toHaveLength(0);
  });

  it("inserts synthetic result for normal missing tool_result", () => {
    const messages: AgentMessage[] = [assistantToolCall("call_1"), textAssistant("next")];
    const report = repairToolUseResultPairing(messages);
    expect(report.added).toHaveLength(1);
    expect(report.messages.map((m) => m.role)).toEqual(["assistant", "toolResult", "assistant"]);
  });

  it("keeps aborted message text content when stripping tool_use", () => {
    const abortedMsg = {
      role: "assistant",
      content: [
        { type: "text", text: "starting..." },
        { type: "toolCall", id: "call_1", name: "exec", arguments: {} },
      ],
      stopReason: "aborted",
    } as unknown as AgentMessage;
    const messages: AgentMessage[] = [abortedMsg, textAssistant("retry")];
    const report = repairToolUseResultPairing(messages);
    // Should keep the text content from the aborted message
    const firstMsg = report.messages[0] as { content?: Array<{ type: string; text?: string }> };
    expect(firstMsg.content).toHaveLength(1);
    expect(firstMsg.content?.[0].type).toBe("text");
    expect(firstMsg.content?.[0].text).toBe("starting...");
  });
});
