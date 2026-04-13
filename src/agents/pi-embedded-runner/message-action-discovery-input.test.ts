import { describe, expect, it } from "vitest";
import { buildEmbeddedMessageActionDiscoveryInput } from "./message-action-discovery-input.js";

describe("buildEmbeddedMessageActionDiscoveryInput", () => {
  it("maps sender and routing scope into message-action discovery context", () => {
    expect(
      buildEmbeddedMessageActionDiscoveryInput({
        channel: "telegram",
        currentChannelId: "chat-1",
        currentThreadTs: "thread-9",
        currentMessageId: "msg-42",
        accountId: "acct-1",
        sessionKey: "agent:main:thread:1",
        sessionId: "session-1",
        agentId: "main",
        senderId: "user-123",
        senderIsOwner: false,
      }),
    ).toEqual({
      cfg: undefined,
      channel: "telegram",
      currentChannelId: "chat-1",
      currentThreadTs: "thread-9",
      currentMessageId: "msg-42",
      accountId: "acct-1",
      sessionKey: "agent:main:thread:1",
      sessionId: "session-1",
      agentId: "main",
      requesterSenderId: "user-123",
      senderIsOwner: false,
    });
  });

  it("normalizes nullable routing fields to undefined", () => {
    expect(
      buildEmbeddedMessageActionDiscoveryInput({
        channel: "slack",
        currentChannelId: null,
        currentThreadTs: null,
        currentMessageId: null,
        accountId: null,
        sessionKey: null,
        sessionId: null,
        agentId: null,
        senderId: null,
        senderIsOwner: false,
      }),
    ).toEqual({
      cfg: undefined,
      channel: "slack",
      currentChannelId: undefined,
      currentThreadTs: undefined,
      currentMessageId: undefined,
      accountId: undefined,
      sessionKey: undefined,
      sessionId: undefined,
      agentId: undefined,
      requesterSenderId: undefined,
      senderIsOwner: false,
    });
  });

  it("preserves owner authorization for downstream channel action gating", () => {
    expect(
      buildEmbeddedMessageActionDiscoveryInput({
        channel: "matrix",
        senderIsOwner: true,
      }),
    ).toEqual({
      cfg: undefined,
      channel: "matrix",
      currentChannelId: undefined,
      currentThreadTs: undefined,
      currentMessageId: undefined,
      accountId: undefined,
      sessionKey: undefined,
      sessionId: undefined,
      agentId: undefined,
      requesterSenderId: undefined,
      senderIsOwner: true,
    });
  });
});
