import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testing, createTelegramThreadBindingManager } from "./thread-bindings.js";

const createForumTopicTelegram = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  createForumTopicTelegram,
}));

import {
  handleTelegramSubagentDeliveryTarget,
  handleTelegramSubagentEnded,
  handleTelegramSubagentSpawning,
} from "./subagent-hooks.js";

const TELEGRAM_HOOKS_CFG = {
  channels: {
    telegram: {
      botToken: "test-token",
    },
  },
} as OpenClawConfig;

function createApi(config: OpenClawConfig = TELEGRAM_HOOKS_CFG): OpenClawPluginApi {
  return {
    config,
  } as unknown as OpenClawPluginApi;
}

describe("telegram subagent hooks", () => {
  beforeEach(async () => {
    createForumTopicTelegram.mockReset().mockResolvedValue({
      chatId: "-100200300",
      topicId: 777,
      name: "topic",
    });
    await __testing.resetTelegramThreadBindingsForTests();
  });

  afterEach(async () => {
    await __testing.resetTelegramThreadBindingsForTests();
  });

  it("binds a thread-requested Telegram subagent to a new child forum topic", async () => {
    createTelegramThreadBindingManager({
      cfg: TELEGRAM_HOOKS_CFG,
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });

    const result = await handleTelegramSubagentSpawning(createApi(), {
      threadRequested: true,
      requester: {
        channel: "telegram",
        accountId: "default",
        to: "telegram:-100200300:topic:55",
        threadId: 55,
      },
      childSessionKey: "agent:main:subagent:child-telegram",
      agentId: "reviewer",
      label: "Review PR #123 with a deliberately long label ".repeat(4),
    });

    expect(result).toEqual({
      status: "ok",
      threadBindingReady: true,
      deliveryOrigin: {
        channel: "telegram",
        accountId: "default",
        to: "-100200300",
        threadId: "777",
      },
    });
    expect(createForumTopicTelegram).toHaveBeenCalledTimes(1);
    const [target, topicName] = createForumTopicTelegram.mock.calls[0] ?? [];
    expect(target).toBe("-100200300");
    expect(String(topicName)).toMatch(/^🤖 Review PR #123/);
    expect(String(topicName).length).toBeLessThanOrEqual(100);

    const bindings = getSessionBindingService().listBySession("agent:main:subagent:child-telegram");
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.conversation.conversationId).toBe("-100200300:topic:777");
  });

  it("returns policy errors before binding", async () => {
    const result = await handleTelegramSubagentSpawning(
      createApi({
        channels: {
          telegram: {
            botToken: "test-token",
            threadBindings: {
              spawnSessions: false,
            },
          },
        },
      } as OpenClawConfig),
      {
        threadRequested: true,
        requester: {
          channel: "telegram",
          accountId: "default",
          to: "-100200300",
        },
        childSessionKey: "agent:main:subagent:child-telegram",
        agentId: "reviewer",
      },
    );

    expect(result).toEqual({
      status: "error",
      error:
        "Thread-bound session spawns are disabled for telegram (set channels.telegram.threadBindings.spawnSessions=true to enable).",
    });
    expect(createForumTopicTelegram).not.toHaveBeenCalled();
  });

  it("rejects non-group requester targets with a Telegram-specific error", async () => {
    createTelegramThreadBindingManager({
      cfg: TELEGRAM_HOOKS_CFG,
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });

    const result = await handleTelegramSubagentSpawning(createApi(), {
      threadRequested: true,
      requester: {
        channel: "telegram",
        accountId: "default",
        to: "12345",
      },
      childSessionKey: "agent:main:subagent:child-telegram",
      agentId: "reviewer",
    });

    expect(result).toEqual({
      status: "error",
      error:
        "Telegram thread-bound subagent sessions require a group or supergroup chat target that can host forum topics.",
    });
    expect(createForumTopicTelegram).not.toHaveBeenCalled();
  });

  it("routes completion delivery to the single bound Telegram topic", async () => {
    createTelegramThreadBindingManager({
      cfg: TELEGRAM_HOOKS_CFG,
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });
    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-telegram",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-100200300:topic:777",
      },
      placement: "current",
    });

    const result = handleTelegramSubagentDeliveryTarget({
      expectsCompletionMessage: true,
      childSessionKey: "agent:main:subagent:child-telegram",
      requesterOrigin: {
        channel: "telegram",
        accountId: "default",
        to: "telegram:-100200300",
      },
    });

    expect(result).toEqual({
      origin: {
        channel: "telegram",
        accountId: "default",
        to: "-100200300",
        threadId: "777",
      },
    });
  });

  it("cleans up only Telegram subagent bindings when a subagent ends", async () => {
    createTelegramThreadBindingManager({
      cfg: TELEGRAM_HOOKS_CFG,
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });
    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-telegram",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-100200300:topic:777",
      },
      placement: "current",
    });
    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:acp:child-telegram",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-100200300:topic:888",
      },
      placement: "current",
    });

    await handleTelegramSubagentEnded({
      targetSessionKey: "agent:main:subagent:child-telegram",
      targetKind: "subagent",
      reason: "complete",
    });

    expect(
      getSessionBindingService().listBySession("agent:main:subagent:child-telegram"),
    ).toHaveLength(0);
    expect(getSessionBindingService().listBySession("agent:main:acp:child-telegram")).toHaveLength(
      1,
    );
  });
});
