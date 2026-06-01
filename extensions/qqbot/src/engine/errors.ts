export const QQBOT_DOCS_URL = "https://docs.openclaw.ai/channels/qqbot";
export const QQBOT_OPEN_PLATFORM_URL = "https://q.qq.com/";

export function formatQqbotNotConfiguredError(): string {
  return [
    "QQBot not configured. Set QQBOT_APP_ID and QQBOT_CLIENT_SECRET, or run `openclaw configure`.",
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
