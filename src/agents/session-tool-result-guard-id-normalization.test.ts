import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];

const asAppendMessage = (message: unknown) => message as AppendMessage;

function getPersistedMessages(sm: SessionManager): AgentMessage[] {
  return sm
    .getEntries()
    .filter((e) => e.type === "message")
    .map((e) => (e as { message: AgentMessage }).message);
}

describe("tool call ID normalization at write time (#21178)", () => {
  it("normalizes OpenAI-style tool call IDs on assistant messages", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "functions.read:0", name: "read", arguments: {} }],
      }),
    );

    const messages = getPersistedMessages(sm);
    expect(messages).toHaveLength(1);
    const block = (messages[0] as { content: Array<{ id?: string }> }).content[0];
    // Colons and dots stripped: "functions.read:0" → "functionsread0"
    expect(block.id).toBe("functionsread0");
  });

  it("normalizes tool call IDs on toolResult messages consistently", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    // Assistant sends a tool call with OpenAI-format ID
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "functions.read:0", name: "read", arguments: {} }],
      }),
    );

    // Tool result references the same raw ID
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "functions.read:0",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
      }),
    );

    const messages = getPersistedMessages(sm);
    expect(messages).toHaveLength(2);
    const assistantBlock = (messages[0] as { content: Array<{ id?: string }> }).content[0];
    const toolResult = messages[1] as { toolCallId?: string };
    // Both should be normalized to the same value
    expect(assistantBlock.id).toBe("functionsread0");
    expect(toolResult.toolCallId).toBe("functionsread0");
  });

  it("normalizes toolUseId on toolResult messages", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolUse", id: "call|special_chars", name: "write", arguments: {} }],
      }),
    );

    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolUseId: "call|special_chars",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }),
    );

    const messages = getPersistedMessages(sm);
    expect(messages).toHaveLength(2);
    const assistantBlock = (messages[0] as { content: Array<{ id?: string }> }).content[0];
    const toolResult = messages[1] as { toolUseId?: string };
    expect(assistantBlock.id).toBe("callspecialchars");
    expect(toolResult.toolUseId).toBe("callspecialchars");
  });

  it("does not modify already-valid alphanumeric tool call IDs", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "toolu01XYZ", name: "read", arguments: {} }],
      }),
    );

    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "toolu01XYZ",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }),
    );

    const messages = getPersistedMessages(sm);
    const assistantBlock = (messages[0] as { content: Array<{ id?: string }> }).content[0];
    const toolResult = messages[1] as { toolCallId?: string };
    // Already alphanumeric — should pass through unchanged
    expect(assistantBlock.id).toBe("toolu01XYZ");
    expect(toolResult.toolCallId).toBe("toolu01XYZ");
  });
});
