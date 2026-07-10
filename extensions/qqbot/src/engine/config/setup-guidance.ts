import { DEFAULT_ACCOUNT_ID } from "./resolve.js";

const QQBOT_DOCS_URL = "https://docs.openclaw.ai/channels/qqbot";

export function qqbotSetupGuidance(): string {
  return `Check the QQBot account appId and clientSecret (or clientSecretFile), then see ${QQBOT_DOCS_URL}`;
}

export function qqbotNotConfiguredMessage(accountId: string): string {
  const guidance =
    accountId === DEFAULT_ACCOUNT_ID
      ? `Set channels.qqbot.appId and clientSecret (or clientSecretFile), or set QQBOT_APP_ID and QQBOT_CLIENT_SECRET, then see ${QQBOT_DOCS_URL}`
      : `Set channels.qqbot.accounts.${accountId}.appId and clientSecret (or clientSecretFile), then see ${QQBOT_DOCS_URL}`;
  return `QQBot not configured (missing appId or clientSecret). ${guidance}`;
}

export function qqbotTokenFailureMessage(detail: string): string {
  return `Failed to get QQBot access_token. ${qqbotSetupGuidance()}. Open platform response: ${detail}`;
}
