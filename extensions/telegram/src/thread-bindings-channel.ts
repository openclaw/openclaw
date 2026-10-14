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

export const telegramThreadBindingLifecycle: Pick<
  ConversationBindings,
  | "createManager"
  | "setIdleTimeoutBySessionKey"
  | "setMaxAgeBySessionKey"
  | "setIdleTimeoutBySessionKeyAsync"
  | "setMaxAgeBySessionKeyAsync"
> = {
  createManager: ({ cfg, accountId }) =>
    createTelegramThreadBindingManager({
      cfg,
      accountId: accountId ?? undefined,
      persist: false,
      enableSweeper: false,
    }),
  setIdleTimeoutBySessionKey: (params) =>
    setTelegramThreadBindingIdleTimeoutBySessionKey(withOptionalAccountId(params)),
  setMaxAgeBySessionKey: (params) =>
    setTelegramThreadBindingMaxAgeBySessionKey(withOptionalAccountId(params)),
  setIdleTimeoutBySessionKeyAsync: (params) =>
    setTelegramThreadBindingIdleTimeoutBySessionKeyAsync(withOptionalAccountId(params)),
  setMaxAgeBySessionKeyAsync: (params) =>
    setTelegramThreadBindingMaxAgeBySessionKeyAsync(withOptionalAccountId(params)),
};
