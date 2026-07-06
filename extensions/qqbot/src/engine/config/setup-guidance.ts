const QQBOT_DOCS_URL = "https://docs.openclaw.ai/channels/qqbot";

export function qqbotSetupGuidance(): string {
  return `Set QQBOT_APP_ID and QQBOT_CLIENT_SECRET, then see ${QQBOT_DOCS_URL}`;
}

export function qqbotNotConfiguredMessage(): string {
  return `QQBot not configured (missing appId or clientSecret). ${qqbotSetupGuidance()}`;
}

export function qqbotTokenFailureMessage(detail: string): string {
  return `Failed to get QQBot access_token. ${qqbotSetupGuidance()}. Open platform response: ${detail}`;
}
