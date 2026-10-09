import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createTelegramThreadBindingManager,
  setTelegramThreadBindingIdleTimeoutBySessionKey,
  setTelegramThreadBindingIdleTimeoutBySessionKeyAsync,
  setTelegramThreadBindingMaxAgeBySessionKey,
  setTelegramThreadBindingMaxAgeBySessionKeyAsync,
} from "./thread-bindings.js";

type ConversationBindings = NonNullable<ChannelPlugin["conversationBindings"]>;

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
    setTelegramThreadBindingIdleTimeoutBySessionKey({
      ...params,
      accountId: params.accountId ?? undefined,
    }),
  setMaxAgeBySessionKey: (params) =>
    setTelegramThreadBindingMaxAgeBySessionKey({
      ...params,
      accountId: params.accountId ?? undefined,
    }),
  setIdleTimeoutBySessionKeyAsync: (params) =>
    setTelegramThreadBindingIdleTimeoutBySessionKeyAsync({
      ...params,
      accountId: params.accountId ?? undefined,
    }),
  setMaxAgeBySessionKeyAsync: (params) =>
    setTelegramThreadBindingMaxAgeBySessionKeyAsync({
      ...params,
      accountId: params.accountId ?? undefined,
    }),
};
