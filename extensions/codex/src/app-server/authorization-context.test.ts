import { beforeEach, describe, expect, it, vi } from "vitest";

const { hasAuthorizationPoliciesMock, resolveTurnAuthorityAuthorizationMock } = vi.hoisted(() => ({
  hasAuthorizationPoliciesMock: vi.fn(),
  resolveTurnAuthorityAuthorizationMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()),
  hasAuthorizationPolicies: hasAuthorizationPoliciesMock,
  resolveTurnAuthorityAuthorization: resolveTurnAuthorityAuthorizationMock,
}));
import { buildCodexAuthorizationContext } from "./authorization-context.js";

describe("buildCodexAuthorizationContext", () => {
  beforeEach(() => {
    hasAuthorizationPoliciesMock.mockReset().mockReturnValue(false);
    resolveTurnAuthorityAuthorizationMock.mockReset();
  });

  it("uses host-issued authority instead of conflicting legacy sender fields", () => {
    const authorization = {
      principal: { kind: "operator", scopes: ["operator.admin"], isOwner: true },
      agentId: "molty",
      sessionKey: "agent:molty:maintenance",
      runId: "run-operator",
      trigger: "gateway",
    } as const;
    const turnAuthority = { authorization } as never;
    resolveTurnAuthorityAuthorizationMock.mockReturnValue(authorization);

    expect(
      buildCodexAuthorizationContext({
        turnAuthority,
        messageProvider: "discord",
        senderId: "spoofed-sender",
        senderIsOwner: false,
        isAuthorizedSender: false,
        memberRoleIds: ["guest"],
      }),
    ).toBe(authorization);
  });

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

  it("uses an unknown principal when policy is active without turn authority", () => {
    hasAuthorizationPoliciesMock.mockReturnValue(true);

    expect(
      buildCodexAuthorizationContext({
        config: {},
        messageProvider: "discord",
        agentAccountId: "molty",
        senderId: "legacy-owner",
        senderName: "Legacy Owner",
        senderUsername: "legacy-owner",
        senderE164: "+15559999999",
        senderIsOwner: true,
        isAuthorizedSender: true,
        memberRoleIds: ["admins"],
        agentId: "molty",
        sessionKey: "agent:molty:discord:channel:maintenance",
      }),
    ).toEqual({
      principal: { kind: "unknown", provider: "discord", accountId: "molty" },
      agentId: "molty",
      sessionKey: "agent:molty:discord:channel:maintenance",
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
