import type {
  TelegramAccountConfig,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { buildTelegramGroupPeerId, type TelegramThreadSpec } from "./bot/helpers.js";

type TelegramErrorPolicy = "always" | "once" | "silent";

const errorCooldownStore = new Map<string, Map<string, number>>();
const DEFAULT_ERROR_COOLDOWN_MS = 14400000;

function pruneExpiredCooldowns(scope: string, now: number) {
  const messageStore = errorCooldownStore.get(scope);
  if (!messageStore) {
    return;
  }
  for (const [message, expiresAt] of messageStore) {
    if (!isFutureDateTimestampMs(expiresAt, { nowMs: now })) {
      messageStore.delete(message);
    }
  }
  if (messageStore.size === 0) {
    errorCooldownStore.delete(scope);
  }
}

export function resolveTelegramErrorPolicy(params: {
  accountConfig?: TelegramAccountConfig;
  groupConfig?: TelegramDirectConfig | TelegramGroupConfig;
  topicConfig?: TelegramTopicConfig;
}): {
  policy: TelegramErrorPolicy;
  cooldownMs: number;
} {
  return {
    policy:
      params.topicConfig?.errorPolicy ||
      params.groupConfig?.errorPolicy ||
      params.accountConfig?.errorPolicy ||
      "always",
    cooldownMs: DEFAULT_ERROR_COOLDOWN_MS,
  };
}

export function buildTelegramErrorScopeKey(params: {
  accountId: string;
  chatId: string | number;
  threadSpec?: TelegramThreadSpec;
}): string {
  return `${params.accountId}:${buildTelegramGroupPeerId(
    params.chatId,
    params.threadSpec ?? { scope: "none" },
  )}`;
}

export function shouldSuppressTelegramError(params: {
  scopeKey: string;
  cooldownMs: number;
  errorMessage?: string;
}): boolean {
  const { scopeKey, cooldownMs, errorMessage } = params;
  const now = asDateTimestampMs(Date.now());
  const messageKey = errorMessage ?? "";
  const scopeStore = errorCooldownStore.get(scopeKey);
  if (now === undefined) {
    errorCooldownStore.delete(scopeKey);
    return false;
  }

  pruneExpiredCooldowns(scopeKey, now);

  if (errorCooldownStore.size > 100) {
    for (const scope of errorCooldownStore.keys()) {
      pruneExpiredCooldowns(scope, now);
    }
  }

  const expiresAt = scopeStore?.get(messageKey);
  if (isFutureDateTimestampMs(expiresAt, { nowMs: now })) {
    return true;
  }

  const nextExpiresAt = resolveExpiresAtMsFromDurationMs(cooldownMs, { nowMs: now });
  if (nextExpiresAt === undefined) {
    scopeStore?.delete(messageKey);
    return false;
  }
  const nextScopeStore = scopeStore ?? new Map<string, number>();
  nextScopeStore.set(messageKey, nextExpiresAt);
  errorCooldownStore.set(scopeKey, nextScopeStore);
  return false;
}
