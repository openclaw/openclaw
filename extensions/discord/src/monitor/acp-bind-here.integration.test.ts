import { ChannelType } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  __testing as sessionBindingTesting,
  getSessionBindingService,
  registerSessionBindingAdapter,
  type SessionBindingBindInput,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { __testing as acpManagerTesting } from "openclaw/plugin-sdk/testing";
import { handleAcpCommand } from "openclaw/plugin-sdk/testing";
import { buildCommandTestParams } from "openclaw/plugin-sdk/testing";
import { setDefaultChannelPluginRegistryForTests } from "openclaw/plugin-sdk/testing";
import * as gatewayCall from "openclaw/plugin-sdk/testing";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  type DiscordClient,
  type DiscordConfig,
  type DiscordMessageEvent,
} from "./message-handler.preflight.test-helpers.js";

const callGatewaySpy = vi.spyOn(gatewayCall, "callGateway");

const baseCfg = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
  acp: {
    enabled: true,
    dispatch: {
      enabled: true,
    },
    backend: "acpx",
  },
  channels: {
    discord: {
      threadBindings: {
        enabled: true,
      },
    },
  },
} satisfies OpenClawConfig;

function createDiscordDmCommandParams(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  const params = buildCommandTestParams(commandBody, cfg, {
    Provider: "discord",
    Surface: "discord",
    OriginatingChannel: "discord",
    OriginatingTo: "user:user-1",
    AccountId: "default",
  });
  params.command.senderId = "user-1";
  return params;
}

function createDmClient(channelId: string): DiscordClient {
  return {
    fetchChannel: async (id: string) => {
      if (id === channelId) {
        return {
          id: channelId,
          type: ChannelType.DM,
        };
      }
      return null;
    },
  } as unknown as DiscordClient;
}

function createInMemoryDiscordBindingAdapter() {
  const bindings: SessionBindingRecord[] = [];

  const bind = async (input: SessionBindingBindInput) => {
    const normalizedConversation = {
      ...input.conversation,
      parentConversationId:
        input.conversation.parentConversationId ??
        (input.placement === "current" ? input.conversation.conversationId : undefined),
    };
    const record = {
      bindingId: `discord:default:${normalizedConversation.conversationId}`,
      targetSessionKey: input.targetSessionKey,
      targetKind: input.targetKind,
      conversation: normalizedConversation,
      status: "active",
      boundAt: 1,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    } satisfies SessionBindingRecord;
    const existingIndex = bindings.findIndex((entry) => entry.bindingId === record.bindingId);
    if (existingIndex >= 0) {
      bindings.splice(existingIndex, 1, record);
    } else {
      bindings.push(record);
    }
    return record;
  };

  registerSessionBindingAdapter({
    channel: "discord",
    accountId: "default",
    capabilities: {
      placements: ["current", "child"],
      bindSupported: true,
      unbindSupported: true,
    },
    bind,
    listBySession: (targetSessionKey) =>
      bindings.filter((entry) => entry.targetSessionKey === targetSessionKey),
    resolveByConversation: (ref) =>
      bindings.find(
        (entry) =>
          entry.conversation.channel === ref.channel &&
          entry.conversation.accountId === ref.accountId &&
          entry.conversation.conversationId === ref.conversationId,
      ) ?? null,
    unbind: async ({ bindingId, targetSessionKey }) => {
      const removed = bindings.filter(
        (entry) =>
          (bindingId && entry.bindingId === bindingId) ||
          (targetSessionKey && entry.targetSessionKey === targetSessionKey),
      );
      for (const entry of removed) {
        const index = bindings.findIndex((candidate) => candidate.bindingId === entry.bindingId);
        if (index >= 0) {
          bindings.splice(index, 1);
        }
      }
      return removed;
    },
  });

  return { bindings };
}

describe("Discord ACP bind here end-to-end flow", () => {
  beforeEach(() => {
    setDefaultChannelPluginRegistryForTests();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    acpManagerTesting.resetAcpSessionManagerForTests();
    loadConfigMock.mockReset().mockReturnValue(baseCfg);
    callGatewaySpy.mockReset().mockResolvedValue({ ok: true } as never);
    acpManagerTesting.setAcpSessionManagerForTests({
      initializeSession: async (input: { sessionKey: string; agent: string; mode: string }) => ({
        runtime: {} as never,
        handle: {
          backend: "acpx",
          runtimeSessionName: `${input.sessionKey}:runtime`,
        },
        meta: {
          backend: "acpx",
          agent: input.agent,
          runtimeSessionName: `${input.sessionKey}:runtime`,
          mode: input.mode,
          state: "idle",
          lastActivityAt: 1,
        },
      }),
    });
  });

  it("binds a Discord DM through /acp spawn --bind here and routes the next DM turn to that ACP session", async () => {
    const adapter = createInMemoryDiscordBindingAdapter();

    const commandResult = await handleAcpCommand(
      createDiscordDmCommandParams("/acp spawn codex --bind here"),
      true,
    );

    expect(commandResult?.reply?.text).toContain("Bound this conversation to");
    expect(adapter.bindings).toHaveLength(1);

    const binding = adapter.bindings[0];
    expect(binding).toMatchObject({
      targetSessionKey: expect.stringMatching(/^agent:codex:acp:/),
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:user-1",
        parentConversationId: "user:user-1",
      },
    });
    expect(
      getSessionBindingService().resolveByConversation({
        channel: "discord",
        accountId: "default",
        conversationId: "user:user-1",
      }),
    )?.toMatchObject({
      targetSessionKey: binding.targetSessionKey,
    });

    const message = createDiscordMessage({
      id: "m-followup-1",
      channelId: "dm-1",
      content: "follow up after bind",
      author: {
        id: "user-1",
        bot: false,
        username: "alice",
      },
    });

    const preflight = await preflightDiscordMessage({
      ...createDiscordPreflightArgs({
        cfg: baseCfg,
        discordConfig: {
          dmPolicy: "open",
        } as DiscordConfig,
        data: {
          channel_id: "dm-1",
          author: message.author,
          message,
        } as DiscordMessageEvent,
        client: createDmClient("dm-1"),
        botUserId: "bot-1",
      }),
    });

    expect(preflight).not.toBeNull();
    expect(preflight?.boundSessionKey).toBe(binding.targetSessionKey);
    expect(preflight?.route.sessionKey).toBe(binding.targetSessionKey);
    expect(preflight?.route.agentId).toBe("codex");
  });
});
