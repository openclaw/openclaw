import type { WhatsAppAccountConfig } from "./runtime-api.js";

export type WhatsAppErrorPolicy = "always" | "once" | "silent";

const errorCooldownStore = new Map<string, Map<string, number>>();
const DEFAULT_ERROR_COOLDOWN_MS = 14400000;

function pruneExpiredCooldowns(messageStore: Map<string, number>, now: number) {
  for (const [message, expiresAt] of messageStore) {
    if (expiresAt <= now) {
      messageStore.delete(message);
    }
  }
}

export function resolveWhatsAppErrorPolicy(params: { accountConfig?: WhatsAppAccountConfig }): {
  policy: WhatsAppErrorPolicy;
  cooldownMs: number;
} {
  const policy: WhatsAppErrorPolicy = params.accountConfig?.errorPolicy ?? "always";
  const cooldownMs =
    typeof params.accountConfig?.errorCooldownMs === "number"
      ? params.accountConfig.errorCooldownMs
      : DEFAULT_ERROR_COOLDOWN_MS;

  return { policy, cooldownMs };
}

export function buildWhatsAppErrorScopeKey(params: { accountId: string; chatId: string }): string {
  return `${params.accountId}:${params.chatId}`;
}

export function shouldSuppressWhatsAppError(params: {
  scopeKey: string;
  cooldownMs: number;
  errorMessage?: string;
}): boolean {
  const { scopeKey, cooldownMs, errorMessage } = params;
  const now = Date.now();
  const messageKey = errorMessage ?? "";
  const scopeStore = errorCooldownStore.get(scopeKey);

  if (scopeStore) {
    pruneExpiredCooldowns(scopeStore, now);
    if (scopeStore.size === 0) {
      errorCooldownStore.delete(scopeKey);
    }
  }

  if (errorCooldownStore.size > 100) {
    for (const [scope, messageStore] of errorCooldownStore) {
      pruneExpiredCooldowns(messageStore, now);
      if (messageStore.size === 0) {
        errorCooldownStore.delete(scope);
      }
    }
  }

  const expiresAt = scopeStore?.get(messageKey);
  if (typeof expiresAt === "number" && expiresAt > now) {
    return true;
  }

  const nextScopeStore = scopeStore ?? new Map<string, number>();
  nextScopeStore.set(messageKey, now + cooldownMs);
  errorCooldownStore.set(scopeKey, nextScopeStore);
  return false;
}

export function isSilentErrorPolicy(policy: WhatsAppErrorPolicy): boolean {
  return policy === "silent";
}

export function resetWhatsAppErrorPolicyStoreForTest() {
  errorCooldownStore.clear();
}
