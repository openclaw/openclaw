import { describe, expect, it } from "vitest";
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
  it("mints immutable sender, roles, route, and trigger identity", () => {
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
        kind: "sender",
        provider: "discord",
        accountId: "molty",
        senderId: "user-42",
        senderIsOwner: false,
        isAuthorizedSender: true,
        roleIds: ["maintainers", "reviewers"],
      },
      agentId: "main",
      sessionKey: "agent:main:discord:channel:maintenance",
      sessionId: "session-1",
      runId: "run-1",
      conversationId: "native-conversation",
      threadId: "thread-7",
      trigger: "user",
    });
  });

  it("uses an explicit service principal when no human sender exists", () => {
    const context = buildCliMcpGrantContext({
      run: run({ trigger: "cron" }),
      config: {},
      requireExplicitMessageTarget: false,
      agentId: "main",
      modelProvider: "openai",
      modelId: "gpt-5",
    });

    expect(context.authorization?.principal).toEqual({
      kind: "service",
      serviceId: "cli-harness",
    });
    expect(context.authorization?.trigger).toBe("cron");
  });
});
