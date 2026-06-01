export const QQBOT_DOCS_URL = "https://docs.openclaw.ai/channels/qqbot";
export const QQBOT_OPEN_PLATFORM_URL = "https://q.qq.com/";
const DEFAULT_ACCOUNT_ID = "default";
const LEGACY_DEFAULT_ACCOUNT_ID = "qqbot";

function normalizeNamedAccountId(accountId: string | null | undefined): string {
  const normalized = accountId?.trim() ?? "";
  return normalized && normalized !== DEFAULT_ACCOUNT_ID && normalized !== LEGACY_DEFAULT_ACCOUNT_ID
    ? normalized
    : "";
}

export function formatQqbotNotConfiguredError(accountId?: string | null): string {
  const namedAccountId = normalizeNamedAccountId(accountId);
  const credentialHint = namedAccountId
    ? `QQBot account "${namedAccountId}" is not configured. Set channels.qqbot.accounts.${namedAccountId}.appId and channels.qqbot.accounts.${namedAccountId}.clientSecret (or clientSecretFile), or run \`openclaw configure\` for that account. QQBOT_APP_ID and QQBOT_CLIENT_SECRET only configure the default QQBot account.`
    : "QQBot not configured. Set QQBOT_APP_ID and QQBOT_CLIENT_SECRET, or run `openclaw configure`.";
  return [
    credentialHint,
    `Get credentials at: ${QQBOT_OPEN_PLATFORM_URL}`,
    `Docs: ${QQBOT_DOCS_URL}`,
  ].join(" ");
}

export function formatQqbotTokenError(details: string): string {
  return [
    "Failed to get QQBot access token. Check that QQBOT_APP_ID and QQBOT_CLIENT_SECRET are correct.",
    `Get credentials at: ${QQBOT_OPEN_PLATFORM_URL}`,
    `Docs: ${QQBOT_DOCS_URL}`,
    `Response: ${details}`,
  ].join(" ");
}

export function formatQqbotTokenNetworkError(details: string): string {
  return [
    "QQBot access token request failed. Check your network connection, server egress, and QQ Open Platform IP whitelist.",
    `Docs: ${QQBOT_DOCS_URL}`,
    `Cause: ${details}`,
  ].join(" ");
}
