const QQBOT_DOCS_URL = "https://docs.openclaw.ai/channels/qqbot";
const QQ_OPEN_PLATFORM_URL = "https://q.qq.com/";

function isDefaultAccount(accountId?: string): boolean {
  return !accountId || accountId === "default";
}

export function formatQQBotCredentialGuidance(accountId?: string): string {
  if (isDefaultAccount(accountId)) {
    return [
      "Set QQBOT_APP_ID and QQBOT_CLIENT_SECRET, or run `openclaw configure`.",
      `Get credentials at: ${QQ_OPEN_PLATFORM_URL}`,
      `Docs: ${QQBOT_DOCS_URL}`,
    ].join(" ");
  }

  return [
    `Set channels.qqbot.accounts.${accountId}.appId and channels.qqbot.accounts.${accountId}.clientSecret.`,
    `Get credentials at: ${QQ_OPEN_PLATFORM_URL}`,
    `Docs: ${QQBOT_DOCS_URL}`,
  ].join(" ");
}

export function formatQQBotNotConfiguredMessage(accountId?: string): string {
  return `QQBot not configured. ${formatQQBotCredentialGuidance(accountId)}`;
}

export function formatQQBotAccessTokenError(rawDetails: string): string {
  return [
    "Failed to get QQBot access token.",
    "Check that your QQBot app ID and client secret are correct.",
    `Get credentials at: ${QQ_OPEN_PLATFORM_URL}`,
    `Docs: ${QQBOT_DOCS_URL}`,
    `Response: ${rawDetails}`,
  ].join(" ");
}

export function formatQQBotNetworkError(path: string, details: string): string {
  return [
    `QQBot API request failed [${path}].`,
    "Check your network connection and that the server IP is whitelisted in QQ Open Platform.",
    `Docs: ${QQBOT_DOCS_URL}`,
    `Cause: ${details}`,
  ].join(" ");
}
