import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createTelegramThreadBindingManager,
  setTelegramThreadBindingIdleTimeoutBySessionKey,
  setTelegramThreadBindingIdleTimeoutBySessionKeyAsync,
  setTelegramThreadBindingMaxAgeBySessionKey,
  setTelegramThreadBindingMaxAgeBySessionKeyAsync,
} from "./thread-bindings.js";

type ConversationBindings = NonNullable<ChannelPlugin["conversationBindings"]>;

function withOptionalAccountId<T extends { accountId?: string | null }>(params: T) {
  return { ...params, accountId: params.accountId ?? undefined };
}

export const telegramThreadBindingSupport: Pick<
  ConversationBindings,
  | "prepareFork"
  | "createManager"
  | "setIdleTimeoutBySessionKey"
  | "setMaxAgeBySessionKey"
  | "setIdleTimeoutBySessionKeyAsync"
  | "setMaxAgeBySessionKeyAsync"
> = {
  prepareFork: async (params) =>
    (await import("./conversation-fork.js")).prepareTelegramConversationFork(params),
  createManager: ({ cfg, accountId }) =>
    createTelegramThreadBindingManager({
      cfg,
      accountId: accountId ?? undefined,
      persist: false,
      enableSweeper: false,
    }),
  // Released synchronous runtime setters dispatch here through 2026-12-31.
  setIdleTimeoutBySessionKey: (params) =>
    setTelegramThreadBindingIdleTimeoutBySessionKey(withOptionalAccountId(params)),
  setMaxAgeBySessionKey: (params) =>
    setTelegramThreadBindingMaxAgeBySessionKey(withOptionalAccountId(params)),
  setIdleTimeoutBySessionKeyAsync: (params) =>
    setTelegramThreadBindingIdleTimeoutBySessionKeyAsync(withOptionalAccountId(params)),
  setMaxAgeBySessionKeyAsync: (params) =>
    setTelegramThreadBindingMaxAgeBySessionKeyAsync(withOptionalAccountId(params)),
};
