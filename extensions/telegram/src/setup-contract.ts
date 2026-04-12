import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/setup";

const TELEGRAM_NAMED_ACCOUNT_PROMOTION_KEYS = [
  // When named accounts already exist, only move auth / transport fields into the
  // promoted account. Shared delivery-policy fields stay at the channel root.
  "name",
  "token",
  "tokenFile",
  "botToken",
  "account",
  "webhookPath",
  "webhookUrl",
  "webhookSecret",
  "streaming",
] as const;

export const singleAccountKeysToMove = ["streaming"];
export const namedAccountPromotionKeys = [...TELEGRAM_NAMED_ACCOUNT_PROMOTION_KEYS];

export function resolveSingleAccountPromotionTarget(params: {
  channel: Record<string, unknown>;
}): string {
  const accounts =
    typeof params.channel.accounts === "object" && params.channel.accounts
      ? (params.channel.accounts as Record<string, unknown>)
      : {};
  const normalizedDefaultAccount =
    typeof params.channel.defaultAccount === "string" && params.channel.defaultAccount.trim()
      ? normalizeAccountId(params.channel.defaultAccount)
      : undefined;
  if (normalizedDefaultAccount) {
    if (normalizedDefaultAccount !== DEFAULT_ACCOUNT_ID) {
      const matchedAccountId = Object.entries(accounts).find(
        ([accountId, value]) =>
          accountId &&
          value &&
          typeof value === "object" &&
          normalizeAccountId(accountId) === normalizedDefaultAccount,
      )?.[0];
      if (matchedAccountId) {
        return matchedAccountId;
      }
    }
    return DEFAULT_ACCOUNT_ID;
  }
  const namedAccounts = Object.entries(accounts).filter(
    ([accountId, value]) => accountId && typeof value === "object" && value,
  );
  if (namedAccounts.length === 1) {
    return namedAccounts[0][0];
  }
  if (
    namedAccounts.length > 1 &&
    accounts[DEFAULT_ACCOUNT_ID] &&
    typeof accounts[DEFAULT_ACCOUNT_ID] === "object"
  ) {
    return DEFAULT_ACCOUNT_ID;
  }
  return DEFAULT_ACCOUNT_ID;
}
