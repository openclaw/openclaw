// Discord helper module supports message handler helpers behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { onTestFinished, vi } from "vitest";
import type { DiscordIngressLifecycle } from "./ingress.js";
import type { createDiscordMessageDispatcher } from "./message-dispatcher.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

export const DEFAULT_DISCORD_BOT_USER_ID = "bot-123";

export function createDiscordHandlerParams(overrides?: {
  botUserId?: string;
  setStatus?: (patch: Record<string, unknown>) => void;
  abortSignal?: AbortSignal;
}): Parameters<typeof createDiscordMessageDispatcher>[0] {
  const cfg: OpenClawConfig = {
    channels: {
      discord: {
        enabled: true,
        token: "test-token",
        groupPolicy: "allowlist",
      },
    },
    messages: {
      inbound: {
        debounceMs: 0,
      },
    },
  };
  const threadBindings = createNoopThreadBindingManager("default");
  onTestFinished(() => threadBindings.stop());
  return {
    cfg,
    discordConfig: cfg.channels?.discord,
    accountId: "default",
    token: "test-token",
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    },
    botUserId: overrides?.botUserId ?? DEFAULT_DISCORD_BOT_USER_ID,
    guildHistories: new Map(),
    historyLimit: 0,
    mediaMaxBytes: 10_000,
    textLimit: 2_000,
    replyToMode: "off" as const,
    dmEnabled: true,
    dmPolicy: "pairing",
    groupDmEnabled: false,
    threadBindings,
    setStatus: overrides?.setStatus,
    abortSignal: overrides?.abortSignal,
  };
}

export function createDiscordPreflightContext(channelId = "ch-1") {
  return {
    data: {
      channel_id: channelId,
      message: {
        id: `msg-${channelId}`,
        channel_id: channelId,
        attachments: [],
      },
    },
    message: {
      id: `msg-${channelId}`,
      channel_id: channelId,
      attachments: [],
    },
    route: {
      sessionKey: `agent:main:discord:channel:${channelId}`,
    },
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

export function createIngressLifecycle(): DiscordIngressLifecycle & {
  onAdopted: ReturnType<typeof vi.fn>;
  onFailed: ReturnType<typeof vi.fn>;
  onCancelled: ReturnType<typeof vi.fn>;
  onAbandoned: ReturnType<typeof vi.fn>;
} {
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

export function createDiscordQueuePreflightContext(channelId = "ch-1") {
  const discordConfig = {
    enabled: true,
    token: "test-token",
    groupPolicy: "allowlist" as const,
  };
  const cfg: OpenClawConfig = {
    channels: {
      discord: discordConfig,
    },
    messages: {
      inbound: {
        debounceMs: 0,
      },
    },
  };
  return {
    ...createDiscordPreflightContext(channelId),
    cfg,
    accountId: "default",
    token: "test-token",
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    },
    textLimit: 2_000,
    replyToMode: "off" as const,
    discordConfig,
    messageText: "hello",
    isDirectMessage: false,
    isGuildMessage: true,
    isGroupDm: false,
    inboundEventKind: "message" as const,
    effectiveWasMentioned: false,
  };
}

export function createDiscordQueuePreflightContextForMessage(data: {
  channel_id: string;
  message: { id: string };
}) {
  const ctx = createDiscordQueuePreflightContext(data.channel_id);
  return {
    ...ctx,
    message: { ...ctx.message, id: data.message.id },
    data: {
      ...ctx.data,
      message: { ...ctx.data.message, id: data.message.id },
    },
  };
}
