import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runAuthorizationPolicies } from "../../plugins/authorization-policy.js";
import type { PluginAuthorizationPolicyRegistryRegistration } from "../../plugins/registry-types.js";
import {
  createOperatorTurnAuthoritySnapshot,
  createTurnAuthoritySnapshot,
} from "../../plugins/turn-authority.js";
import { buildCliMcpGrantContext } from "./mcp-grant-context.js";
import type { RunCliAgentParams } from "./types.js";

function run(overrides: Partial<RunCliAgentParams> = {}): RunCliAgentParams {
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:discord:channel:maintenance",
    sessionFile: "session.jsonl",
    workspaceDir: "/workspace",
    prompt: "hello",
    provider: "codex-cli",
    timeoutMs: 1_000,
    runId: "run-1",
    ...overrides,
  };
}

describe("buildCliMcpGrantContext authorization", () => {
  it("keeps legacy sender selectors outside policy authority", () => {
    const context = buildCliMcpGrantContext({
      run: run({
        trigger: "user",
        messageProvider: "discord",
        agentAccountId: "molty",
        senderId: "user-42",
        senderIsOwner: false,
        isAuthorizedSender: true,
        memberRoleIds: ["reviewers", "maintainers", "maintainers"],
        chatId: "native-conversation",
        currentChannelId: "channel-maintenance",
        parentConversationId: "maintenance",
        currentThreadTs: "thread-7",
      }),
      config: {},
      requireExplicitMessageTarget: true,
      agentId: "main",
      modelProvider: "openai",
      modelId: "gpt-5",
    });

    expect(context.authorization).toEqual({
      principal: {
        kind: "unknown",
        provider: "discord",
        accountId: "molty",
      },
      agentId: "main",
      sessionKey: "agent:main:discord:channel:maintenance",
      sessionId: "session-1",
      runId: "run-1",
      conversationId: "native-conversation",
      parentConversationId: "maintenance",
      threadId: "thread-7",
      trigger: "user",
    });
    expect(context.requesterIdentitySource).toBe("legacy");
    expect(context.channelContext?.sender?.id).toBe("user-42");
    expect(context.senderIsOwner).toBe(false);
  });

  it("normalizes legacy provider and sender fallbacks independently", () => {
    const context = buildCliMcpGrantContext({
      run: run({
        messageProvider: "   ",
        messageChannel: " Discord ",
        senderId: "   ",
        channelContext: {
          sender: { id: " channel-sender " },
        },
      }),
      config: {},
      requireExplicitMessageTarget: false,
      agentId: "main",
      modelProvider: "openai",
      modelId: "gpt-5",
    });

    expect(context.messageProvider).toBe("discord");
    expect(context.channelContext).toEqual({ sender: { id: "channel-sender" } });
    expect(context.authorization?.principal).toEqual({ kind: "unknown", provider: "discord" });
  });

  it("uses admitted sender identity while preserving transport route facts", () => {
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: {
        kind: "sender",
        provider: "discord",
        accountId: "canonical-account",
        senderId: "canonical-sender",
        senderIsOwner: false,
        isAuthorizedSender: true,
        roleIds: ["maintainers", "reviewers"],
      },
      agentId: "main",
      sessionKey: "agent:main:discord:channel:maintenance",
      sessionId: "session-1",
      runId: "run-1",
      conversationId: "discord:maintenance",
      trigger: "user",
    });
    const context = buildCliMcpGrantContext({
      run: run({
        turnAuthority,
        messageProvider: "telegram",
        agentAccountId: "route-account",
        senderId: "legacy-sender",
        senderIsOwner: true,
        isAuthorizedSender: false,
        memberRoleIds: ["guests"],
        senderName: "Legacy Name",
        senderUsername: "legacy-user",
        senderE164: "+15550001111",
        channelContext: {
          sender: { id: "legacy-channel-sender", displayName: "Legacy Name" },
          chat: { id: "route-chat", title: "Route chat" },
        },
      }),
      config: {},
      requireExplicitMessageTarget: true,
      agentId: "main",
      modelProvider: "openai",
      modelId: "gpt-5",
    });

    expect(context).toMatchObject({
      authorization: turnAuthority.authorization,
      requesterIdentitySource: "authority",
      messageProvider: "telegram",
      accountId: "route-account",
      senderIsOwner: false,
      channelContext: {
        sender: { id: "canonical-sender" },
        chat: { id: "route-chat" },
      },
    });
    expect(context.senderName).toBeUndefined();
    expect(context.senderUsername).toBeUndefined();
    expect(context.senderE164).toBeUndefined();
  });

  it("rebinds issued authority to the current CLI execution identity", () => {
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: {
        kind: "sender",
        provider: "discord",
        senderId: "canonical-sender",
        senderIsOwner: false,
      },
      agentId: "source-agent",
      sessionKey: "agent:source-agent:discord:channel:source",
      sessionId: "source-session",
      runId: "source-run",
      conversationId: "discord:maintenance",
      parentConversationId: "discord:ops",
      threadId: "thread-7",
      trigger: "gateway",
    });
    const context = buildCliMcpGrantContext({
      run: run({
        turnAuthority,
        runtimePolicySessionKey: "agent:main:discord:default:direct:canonical-sender",
        trigger: "user",
      }),
      config: {},
      requireExplicitMessageTarget: false,
      agentId: "main",
      modelProvider: "openai",
      modelId: "gpt-5",
    });

    expect(context.authorization).toEqual({
      principal: turnAuthority.authorization.principal,
      agentId: "main",
      sessionKey: "agent:main:discord:default:direct:canonical-sender",
      sessionId: "session-1",
      runId: "run-1",
      conversationId: "discord:maintenance",
      parentConversationId: "discord:ops",
      threadId: "thread-7",
      trigger: "user",
    });
    expect(context.requesterIdentitySource).toBe("authority");
    expect(context.sessionKey).toBe("agent:main:discord:channel:maintenance");
    expect(context.runtimePolicySessionKey).toBe(
      "agent:main:discord:default:direct:canonical-sender",
    );
  });

  it.each([
    {
      label: "operator",
      authority: createOperatorTurnAuthoritySnapshot({
        scopes: ["operator.admin"],
        isOwner: true,
        agentId: "main",
        sessionKey: "agent:main:discord:channel:maintenance",
        sessionId: "session-1",
        runId: "run-1",
        trigger: "gateway",
      }),
      expectedOwner: true,
    },
    {
      label: "service",
      authority: createTurnAuthoritySnapshot({
        principal: { kind: "service", serviceId: "scheduler" },
        agentId: "main",
        sessionKey: "agent:main:discord:channel:maintenance",
        sessionId: "session-1",
        runId: "run-1",
        trigger: "cron",
      }),
      expectedOwner: false,
    },
    {
      label: "unknown",
      authority: createTurnAuthoritySnapshot({
        principal: { kind: "unknown", provider: "discord", accountId: "unknown-account" },
        agentId: "main",
        sessionKey: "agent:main:discord:channel:maintenance",
        sessionId: "session-1",
        runId: "run-1",
        trigger: "unknown",
      }),
      expectedOwner: false,
    },
  ])("clears unattested sender selectors for $label authority", ({ authority, expectedOwner }) => {
    const context = buildCliMcpGrantContext({
      run: run({
        turnAuthority: authority,
        messageProvider: "webchat",
        agentAccountId: "route-account",
        senderId: "legacy-sender",
        senderIsOwner: true,
        senderName: "Legacy Name",
        senderUsername: "legacy-user",
        senderE164: "+15550001111",
        channelContext: {
          sender: { id: "legacy-channel-sender" },
          chat: { id: "route-chat" },
        },
      }),
      config: {},
      requireExplicitMessageTarget: false,
      agentId: "main",
      modelProvider: "openai",
      modelId: "gpt-5",
    });

    expect(context.authorization).toEqual(authority.authorization);
    expect(context.requesterIdentitySource).toBe("authority");
    expect(context.messageProvider).toBe("webchat");
    expect(context.accountId).toBe("route-account");
    expect(context.senderIsOwner).toBe(expectedOwner);
    expect(context.channelContext).toEqual({ chat: { id: "route-chat" } });
    expect(context.senderName).toBeUndefined();
    expect(context.senderUsername).toBeUndefined();
    expect(context.senderE164).toBeUndefined();
  });

  it("uses an unknown principal when no issued authority exists", () => {
    const context = buildCliMcpGrantContext({
      run: run({ trigger: "cron" }),
      config: {},
      requireExplicitMessageTarget: false,
      agentId: "main",
      modelProvider: "openai",
      modelId: "gpt-5",
    });

    expect(context.authorization?.principal).toEqual({ kind: "unknown" });
    expect(context.requesterIdentitySource).toBe("legacy");
    expect(context.authorization?.trigger).toBe("cron");
  });

  it("keeps a legacy grant unknown when authorization policy loads later", async () => {
    const policyConfig: OpenClawConfig = {
      plugins: {
        entries: {
          "owner-guard": {
            authorization: {
              requiredPolicies: [{ id: "owner-only", operations: ["tool.call"] }],
            },
          },
        },
      },
    };
    const ownerPolicy: PluginAuthorizationPolicyRegistryRegistration = {
      pluginId: "owner-guard",
      source: "test",
      policy: {
        id: "owner-only",
        description: "Requires host-issued owner authority",
        handlers: {
          "tool.call": (_request, context) =>
            (context.principal.kind === "sender" && context.principal.senderIsOwner) ||
            (context.principal.kind === "operator" && context.principal.isOwner)
              ? { effect: "pass" }
              : { effect: "deny", code: "owner-required" },
        },
      },
    };
    const request = {
      operation: "tool.call" as const,
      toolName: "message",
      phase: "final" as const,
      input: { action: "reply" },
    };
    const legacyContext = buildCliMcpGrantContext({
      run: run({
        messageProvider: "discord",
        agentAccountId: "molty",
        senderId: "forged-owner",
        senderIsOwner: true,
        isAuthorizedSender: true,
        memberRoleIds: ["maintainers"],
        senderName: "Forged Owner",
      }),
      config: {},
      requireExplicitMessageTarget: false,
      agentId: "main",
      modelProvider: "openai",
      modelId: "gpt-5",
    });

    expect(legacyContext.authorization?.principal).toEqual({
      kind: "unknown",
      provider: "discord",
      accountId: "molty",
    });
    expect(legacyContext.requesterIdentitySource).toBe("legacy");
    expect(legacyContext.channelContext?.sender?.id).toBe("forged-owner");
    expect(legacyContext.senderName).toBe("Forged Owner");
    expect(legacyContext.senderIsOwner).toBe(false);
    const legacyAuthorization = legacyContext.authorization;
    if (!legacyAuthorization) {
      throw new Error("expected CLI grant authorization");
    }
    await expect(
      runAuthorizationPolicies({
        request,
        context: legacyAuthorization,
        config: policyConfig,
        registry: { authorizationPolicies: [ownerPolicy] },
      }),
    ).resolves.toMatchObject({ denied: true, code: "owner-required" });

    const turnAuthority = createTurnAuthoritySnapshot({
      principal: {
        kind: "sender",
        provider: "discord",
        accountId: "molty",
        senderId: "issued-owner",
        senderIsOwner: true,
        isAuthorizedSender: true,
        roleIds: ["maintainers"],
      },
      agentId: "main",
      sessionKey: "agent:main:discord:channel:maintenance",
      sessionId: "session-1",
      runId: "run-1",
      trigger: "user",
    });
    const issuedContext = buildCliMcpGrantContext({
      run: run({
        turnAuthority,
        senderId: "forged-non-owner",
        senderIsOwner: false,
        memberRoleIds: ["guests"],
      }),
      config: {},
      requireExplicitMessageTarget: false,
      agentId: "main",
      modelProvider: "openai",
      modelId: "gpt-5",
    });

    expect(issuedContext.authorization).toEqual(turnAuthority.authorization);
    expect(issuedContext.requesterIdentitySource).toBe("authority");
    const issuedAuthorization = issuedContext.authorization;
    if (!issuedAuthorization) {
      throw new Error("expected issued CLI grant authorization");
    }
    await expect(
      runAuthorizationPolicies({
        request,
        context: issuedAuthorization,
        config: policyConfig,
        registry: { authorizationPolicies: [ownerPolicy] },
      }),
    ).resolves.toBeUndefined();
  });
});
