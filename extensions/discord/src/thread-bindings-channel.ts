import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ResolvedDiscordAccount } from "./accounts.js";
import { loadDiscordThreadBindingsManagerModule } from "./channel.loaders.js";
import {
  setThreadBindingIdleTimeoutBySessionKeyAsync,
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
  setIdleTimeoutBySessionKeyAsync: async (params) =>
    (
      await setThreadBindingIdleTimeoutBySessionKeyAsync({
        ...params,
        accountId: params.accountId ?? undefined,
      })
    ).map(toConversationLifecycleBinding),
  setMaxAgeBySessionKeyAsync: async (params) =>
    (
      await setThreadBindingMaxAgeBySessionKeyAsync({
        ...params,
        accountId: params.accountId ?? undefined,
      })
    ).map(toConversationLifecycleBinding),
};
