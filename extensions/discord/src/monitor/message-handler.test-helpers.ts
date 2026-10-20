import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { onTestFinished, vi } from "vitest";
import type { DiscordIngressLifecycle } from "./ingress.js";
import type { createDiscordMessageDispatcher } from "./message-dispatcher.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

export const DEFAULT_DISCORD_BOT_USER_ID = "bot-123";

function createHandlerContext() {
  const discordConfig = { enabled: true, token: "test-token", groupPolicy: "allowlist" as const };
  const cfg: OpenClawConfig = {
    channels: { discord: discordConfig },
    messages: { inbound: { debounceMs: 0 } },
  };
  return {
    cfg,
    discordConfig,
    accountId: "default",
    token: "test-token",
    textLimit: 2_000,
    replyToMode: "off" as const,
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    },
  };
}

export function createDiscordHandlerParams(overrides?: {
  botUserId?: string;
  setStatus?: (patch: Record<string, unknown>) => void;
  abortSignal?: AbortSignal;
}): Parameters<typeof createDiscordMessageDispatcher>[0] {
  const threadBindings = createNoopThreadBindingManager("default");
  onTestFinished(() => threadBindings.stop());
  return {
    ...createHandlerContext(),
    botUserId: overrides?.botUserId ?? DEFAULT_DISCORD_BOT_USER_ID,
    guildHistories: new Map(),
    historyLimit: 0,
    mediaMaxBytes: 10_000,
    dmEnabled: true,
    dmPolicy: "pairing",
    groupDmEnabled: false,
    threadBindings,
    setStatus: overrides?.setStatus,
    abortSignal: overrides?.abortSignal,
  };
}

export function createDiscordPreflightContext(channelId = "ch-1", messageId = `msg-${channelId}`) {
  const message = { id: messageId, channel_id: channelId, attachments: [] };
  return {
    data: { channel_id: channelId, message: { ...message, attachments: [] } },
    message,
    route: { sessionKey: `agent:main:discord:channel:${channelId}` },
    baseSessionKey: `agent:main:discord:channel:${channelId}`,
    messageChannelId: channelId,
    messageText: "hello",
    isDirectMessage: true,
    isGroupDm: false,
    isGuildMessage: false,
    inboundEventKind: "message",
    effectiveWasMentioned: false,
  };
}

export function createIngressLifecycle(): DiscordIngressLifecycle &
  Record<"onAdopted" | "onFailed" | "onCancelled" | "onAbandoned", ReturnType<typeof vi.fn>> {
  return {
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(async () => {}),
    onDeferred: vi.fn(),
    onAdoptionFinalizing: vi.fn(),
    onFailed: vi.fn(async () => {}),
    onCancelled: vi.fn(async () => {}),
    onAbandoned: vi.fn(async () => {}),
  };
}

export function createDiscordQueuePreflightContext(channelId = "ch-1", messageId?: string) {
  return {
    ...createDiscordPreflightContext(channelId, messageId),
    ...createHandlerContext(),
    isDirectMessage: false,
    isGuildMessage: true,
    inboundEventKind: "message" as const,
  };
}

export function createDiscordQueuePreflightContextForMessage(data: {
  channel_id: string;
  message: { id: string };
}) {
  return createDiscordQueuePreflightContext(data.channel_id, data.message.id);
}
