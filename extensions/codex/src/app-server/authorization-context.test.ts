import { describe, expect, it } from "vitest";
import { buildCodexAuthorizationContext } from "./authorization-context.js";

describe("buildCodexAuthorizationContext", () => {
  it("preserves authenticated sender, role, channel, and thread facts", () => {
    expect(
      buildCodexAuthorizationContext({
        messageProvider: "discord",
        agentAccountId: "molty",
        senderId: "maintainer-1",
        senderIsOwner: false,
        isAuthorizedSender: true,
        memberRoleIds: ["write", "maintainers", "write"],
        agentId: "main",
        sessionKey: "agent:main:discord:channel:maintenance",
        sessionId: "session-1",
        runId: "run-1",
        conversationId: "maintenance",
        parentConversationId: "guild-1",
        currentThreadTs: "thread-1",
        trigger: "user",
      }),
    ).toEqual({
      principal: {
        kind: "sender",
        provider: "discord",
        accountId: "molty",
        senderId: "maintainer-1",
        senderIsOwner: false,
        isAuthorizedSender: true,
        roleIds: ["maintainers", "write"],
      },
      agentId: "main",
      sessionKey: "agent:main:discord:channel:maintenance",
      sessionId: "session-1",
      runId: "run-1",
      conversationId: "maintenance",
      parentConversationId: "guild-1",
      threadId: "thread-1",
      trigger: "user",
    });
  });

  it("keeps system turns explicitly unknown instead of inventing a sender", () => {
    expect(
      buildCodexAuthorizationContext({
        messageChannel: "telegram",
        agentAccountId: "default",
        sessionId: "session-2",
      }),
    ).toEqual({
      principal: { kind: "unknown", provider: "telegram", accountId: "default" },
      sessionId: "session-2",
    });
  });

  it("never treats the model provider as sender provenance", () => {
    expect(
      buildCodexAuthorizationContext({
        provider: "openai",
        senderId: "maintainer-1",
      }),
    ).toEqual({
      principal: { kind: "sender", senderId: "maintainer-1" },
    });
    expect(buildCodexAuthorizationContext({ provider: "openai" })).toEqual({
      principal: { kind: "unknown" },
    });
    expect(
      buildCodexAuthorizationContext({
        provider: "openai",
        messageProvider: "discord",
        senderId: "maintainer-1",
      }),
    ).toEqual({
      principal: { kind: "sender", provider: "discord", senderId: "maintainer-1" },
    });
  });
});
