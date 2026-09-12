import { normalizeAccountId, resolveAccountKey } from "openclaw/plugin-sdk/account-resolution";
import manifest from "../openclaw.plugin.json" with { type: "json" };

export const signalAccountKeyPolicy = manifest.channelAccountKeyPolicies.signal;

export function resolveSignalAccountKey<T>(
  accounts: Record<string, T> | undefined,
  accountId: string,
): string | undefined {
  return resolveAccountKey(
    accounts,
    normalizeAccountId(accountId),
    normalizeAccountId,
    signalAccountKeyPolicy,
  );
}

export function resolveSignalAccountEntry<T>(
  accounts: Record<string, T> | undefined,
  accountId: string,
): T | undefined {
  const key = resolveSignalAccountKey(accounts, accountId);
  return key === undefined ? undefined : accounts?.[key];
}
