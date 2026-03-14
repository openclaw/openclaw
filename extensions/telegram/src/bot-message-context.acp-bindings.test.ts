import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureConfiguredAcpBindingSessionMock = vi.hoisted(() => vi.fn());
const resolveConfiguredAcpBindingRecordMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/acp/persistent-bindings.js", () => ({
  ensureConfiguredAcpBindingSession: (...args: unknown[]) =>
    ensureConfiguredAcpBindingSessionMock(...args),
  resolveConfiguredAcpBindingRecord: (...args: unknown[]) =>
    resolveConfiguredAcpBindingRecordMock(...args),
}));

import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

function createConfiguredTelegramBinding() {
  return {
    spec: {
      channel: "telegram",
      accountId: "work",
      conversationId: "-1001234567890:topic:42",
      parentConversationId: "-1001234567890",
      agentId: "codex",
      mode: "persistent",
    },
    record: {
      bindingId: "config:acp:telegram:work:-1001234567890:topic:42",
      targetSessionKey: "agent:codex:acp:binding:telegram:work:abc123",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "work",
        conversationId: "-1001234567890:topic:42",
        parentConversationId: "-1001234567890",
      },
      status: "active",
      boundAt: 0,
      metadata: {
        source: "config",
        mode: "persistent",
        agentId: "codex",
      },
    },
  } as const;
}

describe("buildTelegramMessageContext ACP configured bindings", () => {
  beforeEach(() => {
    ensureConfiguredAcpBindingSessionMock.mockReset();
    resolveConfiguredAcpBindingRecordMock.mockReset();
    resolveConfiguredAcpBindingRecordMock.mockReturnValue(createConfiguredTelegramBinding());
    ensureConfiguredAcpBindingSessionMock.mockResolvedValue({
      ok: true,
      sessionKey: "agent:codex:acp:binding:telegram:work:abc123",
    });
  });

  it("treats configured topic bindings as explicit route matches on non-default accounts", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      accountId: "work",
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "OpenClaw", is_forum: true },
        message_thread_id: 42,
        text: "hello",
      },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.route.accountId).toBe("work");
    expect(ctx?.route.matchedBy).toBe("binding.channel");
    expect(ctx?.route.sessionKey).toBe("agent:codex:acp:binding:telegram:work:abc123");
    expect(ensureConfiguredAcpBindingSessionMock).toHaveBeenCalledTimes(1);
  });

  it("skips ACP session initialization when topic access is denied", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      accountId: "work",
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "OpenClaw", is_forum: true },
        message_thread_id: 42,
        text: "hello",
      },
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: { enabled: false },
      }),
    });

    expect(ctx).toBeNull();
    expect(resolveConfiguredAcpBindingRecordMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredAcpBindingSessionMock).not.toHaveBeenCalled();
  });

  it("defers ACP session initialization for unauthorized control commands", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      accountId: "work",
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "OpenClaw", is_forum: true },
        message_thread_id: 42,
        text: "/new",
      },
      cfg: {
        channels: {
          telegram: {},
        },
        commands: {
          useAccessGroups: true,
        },
      },
    });

    expect(ctx).toBeNull();
    expect(resolveConfiguredAcpBindingRecordMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredAcpBindingSessionMock).not.toHaveBeenCalled();
  });

  it("drops inbound processing when configured ACP binding initialization fails", async () => {
    ensureConfiguredAcpBindingSessionMock.mockResolvedValue({
      ok: false,
      sessionKey: "agent:codex:acp:binding:telegram:work:abc123",
      error: "gateway unavailable",
    });

    const ctx = await buildTelegramMessageContextForTest({
      accountId: "work",
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "OpenClaw", is_forum: true },
        message_thread_id: 42,
        text: "hello",
      },
    });

    expect(ctx).toBeNull();
    expect(resolveConfiguredAcpBindingRecordMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredAcpBindingSessionMock).toHaveBeenCalledTimes(1);
  });
});
