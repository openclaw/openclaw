import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { MSTeamsConfig } from "../runtime-api.js";

export function resolveMSTeamsWebhookPath(
  channelConfig: Pick<MSTeamsConfig, "webhook"> | undefined,
  accountId: string,
  account?: Pick<MSTeamsConfig, "webhook">,
): string {
  const rootPath = channelConfig?.webhook?.path?.trim() || "/api/messages";
  return (
    account?.webhook?.path?.trim() ||
    (accountId === DEFAULT_ACCOUNT_ID ? rootPath : `${rootPath.replace(/\/+$/u, "")}/${accountId}`)
  );
}
