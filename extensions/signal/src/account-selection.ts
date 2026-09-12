import {
  normalizeAccountId,
  resolveChannelAccountKey,
} from "openclaw/plugin-sdk/account-resolution";

export function resolveSignalAccountKey<T>(
  accounts: Record<string, T> | undefined,
  accountId: string,
): string | undefined {
  return resolveChannelAccountKey(accounts, normalizeAccountId(accountId), "signal");
}

export function resolveSignalAccountEntry<T>(
  accounts: Record<string, T> | undefined,
  accountId: string,
): T | undefined {
  const key = resolveSignalAccountKey(accounts, accountId);
  return key === undefined ? undefined : accounts?.[key];
}
