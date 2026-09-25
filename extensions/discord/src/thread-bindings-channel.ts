import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ResolvedDiscordAccount } from "./accounts.js";
import { loadDiscordThreadBindingsManagerModule } from "./channel.loaders.js";
import {
  setThreadBindingIdleTimeoutBySessionKey,
  setThreadBindingIdleTimeoutBySessionKeyAsync,
  setThreadBindingMaxAgeBySessionKey,
  setThreadBindingMaxAgeBySessionKeyAsync,
} from "./monitor/thread-bindings.session-updates.js";
import { defaultTopLevelPlacement } from "./thread-binding-api.js";

function toConversationLifecycleBinding(binding: {
  boundAt: number;
  lastActivityAt?: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
}) {
  return {
    boundAt: binding.boundAt,
    lastActivityAt:
      typeof binding.lastActivityAt === "number" ? binding.lastActivityAt : binding.boundAt,
    idleTimeoutMs: typeof binding.idleTimeoutMs === "number" ? binding.idleTimeoutMs : undefined,
    maxAgeMs: typeof binding.maxAgeMs === "number" ? binding.maxAgeMs : undefined,
  };
}

export const discordConversationBindings: NonNullable<
  ChannelPlugin<ResolvedDiscordAccount>["conversationBindings"]
> = {
  supportsCurrentConversationBinding: true,
  bindingStore: "adapter",
  defaultTopLevelPlacement,
  createManager: async ({ cfg, accountId }) =>
    (await loadDiscordThreadBindingsManagerModule()).createThreadBindingManager({
      cfg,
      accountId: accountId ?? undefined,
      persist: false,
      enableSweeper: false,
    }),
  setIdleTimeoutBySessionKey: ({ targetSessionKey, accountId, idleTimeoutMs }) =>
    setThreadBindingIdleTimeoutBySessionKey({
      targetSessionKey,
      accountId: accountId ?? undefined,
      idleTimeoutMs,
    }).map(toConversationLifecycleBinding),
  setMaxAgeBySessionKey: ({ targetSessionKey, accountId, maxAgeMs }) =>
    setThreadBindingMaxAgeBySessionKey({
      targetSessionKey,
      accountId: accountId ?? undefined,
      maxAgeMs,
    }).map(toConversationLifecycleBinding),
  setIdleTimeoutBySessionKeyAsync: async ({ targetSessionKey, accountId, idleTimeoutMs }) =>
    (
      await setThreadBindingIdleTimeoutBySessionKeyAsync({
        targetSessionKey,
        accountId: accountId ?? undefined,
        idleTimeoutMs,
      })
    ).map(toConversationLifecycleBinding),
  setMaxAgeBySessionKeyAsync: async ({ targetSessionKey, accountId, maxAgeMs }) =>
    (
      await setThreadBindingMaxAgeBySessionKeyAsync({
        targetSessionKey,
        accountId: accountId ?? undefined,
        maxAgeMs,
      })
    ).map(toConversationLifecycleBinding),
};
