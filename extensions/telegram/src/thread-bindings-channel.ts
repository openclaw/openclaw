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
  setIdleTimeoutBySessionKey: ({ targetSessionKey, accountId, idleTimeoutMs }) =>
    setTelegramThreadBindingIdleTimeoutBySessionKey({
      targetSessionKey,
      accountId: accountId ?? undefined,
      idleTimeoutMs,
    }),
  setMaxAgeBySessionKey: ({ targetSessionKey, accountId, maxAgeMs }) =>
    setTelegramThreadBindingMaxAgeBySessionKey({
      targetSessionKey,
      accountId: accountId ?? undefined,
      maxAgeMs,
    }),
  setIdleTimeoutBySessionKeyAsync: ({ targetSessionKey, accountId, idleTimeoutMs }) =>
    setTelegramThreadBindingIdleTimeoutBySessionKeyAsync({
      targetSessionKey,
      accountId: accountId ?? undefined,
      idleTimeoutMs,
    }),
  setMaxAgeBySessionKeyAsync: ({ targetSessionKey, accountId, maxAgeMs }) =>
    setTelegramThreadBindingMaxAgeBySessionKeyAsync({
      targetSessionKey,
      accountId: accountId ?? undefined,
      maxAgeMs,
    }),
};
