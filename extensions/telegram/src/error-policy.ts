import type {
  TelegramAccountConfig,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { buildTelegramGroupPeerId, type TelegramThreadSpec } from "./bot/helpers.js";

type TelegramErrorPolicy = "always" | "once" | "silent";

const errorCooldownStore = new Map<string, Map<string, number>>();
const DEFAULT_ERROR_COOLDOWN_MS = 14400000;

function pruneExpiredCooldowns(scope: string, messageStore: Map<string, number>, now: number) {
  for (const [message, expiresAt] of messageStore) {
    if (expiresAt <= now) {
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
  const now = Date.now();
  const messageKey = errorMessage ?? "";
  const scopeStore = errorCooldownStore.get(scopeKey);
  if (scopeStore) {
    pruneExpiredCooldowns(scopeKey, scopeStore, now);
  }

  if (errorCooldownStore.size > 100) {
    for (const [scope, messages] of errorCooldownStore) {
      pruneExpiredCooldowns(scope, messages, now);
    }
  }

  const expiresAt = scopeStore?.get(messageKey);
  if (expiresAt !== undefined && expiresAt > now) {
    return true;
  }

  const nextScopeStore = scopeStore ?? new Map<string, number>();
  nextScopeStore.set(messageKey, now + cooldownMs);
  errorCooldownStore.set(scopeKey, nextScopeStore);
  return false;
}
