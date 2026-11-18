import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";

installDiscordIngressTestRuntime();
import { expect, it, onTestFinished, vi } from "vitest";
import { ChannelType } from "../internal/discord.js";

const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/runtime-config-snapshot")
  >("openclaw/plugin-sdk/runtime-config-snapshot");
  return {
    ...actual,
    captureRuntimeConfigAsyncReader: () => async () => loadConfigMock(),
  };
});

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  getSessionBindingService,
  registerSessionBindingAdapter,
  type SessionBindingBindInput,
  type SessionBindingRecord,
  testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/conversation-runtime";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  type DiscordClient,
  type DiscordMessageEvent,
} from "./message-handler.preflight.test-helpers.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender", threadBindings: { enabled: true } },
  acp: { enabled: true, dispatch: { enabled: true }, backend: "acpx" },
} satisfies OpenClawConfig;

function createDmClient(channelId: string): DiscordClient {
  return {
    fetchChannel: async (id: string) =>
      id === channelId ? { id: channelId, type: ChannelType.DM } : null,
  } as unknown as DiscordClient;
}

function createInMemoryDiscordBindingAdapter() {
  const bindings = new Map<string, SessionBindingRecord>();

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
    bindings.set(record.bindingId, record);
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
      [...bindings.values()].filter((entry) => entry.targetSessionKey === targetSessionKey),
    resolveByConversation: (ref) =>
      [...bindings.values()].find(
        (entry) =>
          entry.conversation.channel === ref.channel &&
          entry.conversation.accountId === ref.accountId &&
          entry.conversation.conversationId === ref.conversationId,
      ) ?? null,
    unbind: async ({ bindingId, targetSessionKey }) => {
      const removed = [...bindings.values()].filter(
        (entry) =>
          (bindingId && entry.bindingId === bindingId) ||
          (targetSessionKey && entry.targetSessionKey === targetSessionKey),
      );
      for (const entry of removed) {
        bindings.delete(entry.bindingId);
      }
      return removed;
    },
  });
}

it("routes the next Discord DM turn to an existing ACP session binding", async () => {
  const threadBindings = createNoopThreadBindingManager("default");
  onTestFinished(() => threadBindings.stop());
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  loadConfigMock.mockReset().mockReturnValue(baseCfg);
  createInMemoryDiscordBindingAdapter();
  const binding = await getSessionBindingService().bind({
    targetSessionKey: "agent:codex:acp:test-session",
    targetKind: "session",
    conversation: {
      channel: "discord",
      accountId: "default",
      conversationId: "user:user-1",
      parentConversationId: "user:user-1",
    },
    placement: "current",
    metadata: { boundBy: "user-1", agentId: "codex", label: "codex" },
  });

  const message = createDiscordMessage({
    id: "m-followup-1",
    channelId: "dm-1",
    content: "follow up after bind",
    author: { id: "user-1", bot: false, username: "alice" },
  });

  const preflight = await preflightDiscordMessage({
    ...createDiscordPreflightArgs({
      cfg: baseCfg,
      discordConfig: { dmPolicy: "open" },
      data: {
        channel_id: "dm-1",
        author: message.author,
        message,
      } as DiscordMessageEvent,
      client: createDmClient("dm-1"),
      botUserId: "bot-1",
      threadBindings,
    }),
    allowFrom: ["*"],
  });

  expect(preflight).toMatchObject({
    boundSessionKey: binding.targetSessionKey,
    route: { sessionKey: binding.targetSessionKey, agentId: "codex" },
  });
  expect(preflight?.threadBinding).toEqual(binding);
});
