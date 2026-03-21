import type {
  TelegramAccountConfig,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-runtime";

export type TelegramErrorPolicy = "always" | "once" | "silent";

type TelegramErrorConfig =
  | TelegramAccountConfig
  | TelegramDirectConfig
  | TelegramGroupConfig
  | TelegramTopicConfig;

interface ErrorCooldownEntry {
  errorMessage?: string;
  expiresAt: number;
}

const errorCooldownStore = new Map<string, ErrorCooldownEntry>();
const DEFAULT_ERROR_COOLDOWN_MS = 14400000;

export function resolveTelegramErrorPolicy(params: {
  accountConfig?: TelegramAccountConfig;
  groupConfig?: TelegramDirectConfig | TelegramGroupConfig;
  topicConfig?: TelegramTopicConfig;
}): {
  policy: TelegramErrorPolicy;
  cooldownMs: number;
} {
  const configs: Array<TelegramErrorConfig | undefined> = [
    params.accountConfig,
    params.groupConfig,
    params.topicConfig,
  ];
  let policy: TelegramErrorPolicy = "always";
  let cooldownMs = DEFAULT_ERROR_COOLDOWN_MS;

  for (const config of configs) {
    if (config?.errorPolicy) {
      policy = config.errorPolicy;
    }
    if (typeof config?.errorCooldownMs === "number") {
      cooldownMs = config.errorCooldownMs;
    }
  }

  return { policy, cooldownMs };
}

export function buildTelegramErrorScopeKey(params: {
  accountId: string;
  chatId: string | number;
  threadId?: string | number | null;
}): string {
  const threadId = params.threadId == null ? "main" : String(params.threadId);
  return `${params.accountId}:${String(params.chatId)}:${threadId}`;
}

export function shouldSuppressTelegramError(params: {
  scopeKey: string;
  cooldownMs: number;
  errorMessage?: string;
}): boolean {
  const { scopeKey, cooldownMs, errorMessage } = params;
  const now = Date.now();
  const entry = errorCooldownStore.get(scopeKey);

  if (errorCooldownStore.size > 100) {
    for (const [key, value] of errorCooldownStore) {
      if (value.expiresAt <= now) {
        errorCooldownStore.delete(key);
      }
    }
  }

  if (entry && entry.expiresAt > now && entry.errorMessage === errorMessage) {
    return true;
  }

  errorCooldownStore.set(scopeKey, {
    errorMessage,
    expiresAt: now + cooldownMs,
  });
  return false;
}

export function isSilentErrorPolicy(policy: TelegramErrorPolicy): boolean {
  return policy === "silent";
}

export function resetTelegramErrorPolicyStoreForTest() {
  errorCooldownStore.clear();
}
