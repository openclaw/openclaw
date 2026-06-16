import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { describe, expect, it } from "vitest";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

function buildInboundMetadataPrefixedText(body: string): string {
  return [
    "Conversation info (untrusted metadata):",
    "```json",
    JSON.stringify({
      chat_id: "channel:123",
      message_id: "msg-1",
      sender_id: "sender-1",
      sender: "Syu",
      timestamp: "Tue 2026-06-16 13:56:07 GMT+9",
      is_group_chat: true,
    }),
    "```",
    "",
    "Sender (untrusted metadata):",
    "```json",
    JSON.stringify({
      label: "Syu (sender-1)",
      id: "sender-1",
      name: "Syu",
      username: "syu8384",
    }),
    "```",
    "",
    body,
  ].join("\n");
}

function getPersistedMessages(sm: SessionManager): AgentMessage[] {
  return sm
    .getEntries()
    .filter((e) => e.type === "message")
    .map((e) => (e as { message: AgentMessage }).message);
}

describe("guardSessionManager inbound metadata stripping", () => {
  it("strips inbound metadata and preserves senderLabel when persisting user messages", () => {
    const sm = SessionManager.inMemory();
    guardSessionManager(sm);

    const body = "what were the 5 email categories?";
    const content = buildInboundMetadataPrefixedText(body);
    sm.appendMessage({
      role: "user",
      content,
      timestamp: Date.now(),
    });

    const persisted = getPersistedMessages(sm);
    expect(persisted).toHaveLength(1);
    const user = persisted[0] as { role: string; content: string; senderLabel?: string };
    expect(user.role).toBe("user");
    expect(user.content).toBe(body);
    expect(user.content).not.toContain("untrusted metadata");
    expect(user.senderLabel).toBe("Syu (sender-1)");
  });

  it("strips inbound metadata from user messages with array content", () => {
    const sm = SessionManager.inMemory();
    guardSessionManager(sm);

    const body = "what were the 5 email categories?";
    const text = buildInboundMetadataPrefixedText(body);
    sm.appendMessage({
      role: "user",
      content: [
        { type: "text", text },
        { type: "text", text: "extra" },
      ],
      timestamp: Date.now(),
    });

    const persisted = getPersistedMessages(sm);
    expect(persisted).toHaveLength(1);
    const user = persisted[0] as {
      role: string;
      content: Array<{ type: string; text: string }>;
      senderLabel?: string;
    };
    expect(user.role).toBe("user");
    expect(user.content[0].text).toBe(body);
    expect(user.content[1].text).toBe("extra");
    expect(user.content.map((c) => c.text).join("")).not.toContain("untrusted metadata");
    expect(user.senderLabel).toBe("Syu (sender-1)");
  });

  it("does not strip inbound metadata from assistant messages", () => {
    const sm = SessionManager.inMemory();
    guardSessionManager(sm);

    const content = buildInboundMetadataPrefixedText("I am the assistant");
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: content }],
      stopReason: "error",
      timestamp: Date.now(),
    });

    const persisted = getPersistedMessages(sm);
    expect(persisted).toHaveLength(1);
    const assistant = persisted[0] as { role: string; content: Array<{ text: string }> };
    expect(assistant.role).toBe("assistant");
    expect(assistant.content[0].text).toContain("untrusted metadata");
  });

  it("preserves an explicit senderLabel when stripping inbound metadata", () => {
    const sm = SessionManager.inMemory();
    guardSessionManager(sm);

    const body = "hello";
    const content = buildInboundMetadataPrefixedText(body);
    sm.appendMessage({
      role: "user",
      content,
      timestamp: Date.now(),
      senderLabel: "Custom Label",
    });

    const persisted = getPersistedMessages(sm);
    const user = persisted[0] as { content: string; senderLabel?: string };
    expect(user.content).toBe(body);
    expect(user.senderLabel).toBe("Custom Label");
  });

  it("keeps the in-memory message identity when no metadata is present", () => {
    const sm = SessionManager.inMemory();
    guardSessionManager(sm);

    const message = { role: "user", content: "plain", timestamp: Date.now() } as const;
    sm.appendMessage(message);

    const persisted = getPersistedMessages(sm);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toBe(message);
  });
});
