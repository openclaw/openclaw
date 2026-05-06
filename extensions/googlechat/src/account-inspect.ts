import { normalizeAccountId, type OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  type GoogleChatCredentialSource,
  inspectCredentialsFromConfig,
  mergeGoogleChatAccountConfig,
} from "./accounts.js";
import type { GoogleChatAccountConfig } from "./types.config.js";

export type InspectedGoogleChatAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  config: GoogleChatAccountConfig;
  credentialSource: GoogleChatCredentialSource;
  configured: boolean;
};

export function inspectGoogleChatAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): InspectedGoogleChatAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? params.cfg.channels?.["googlechat"]?.defaultAccount,
  );
  const baseEnabled = params.cfg.channels?.["googlechat"]?.enabled !== false;
  const merged = mergeGoogleChatAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const inspected = inspectCredentialsFromConfig({ accountId, account: merged });

  return {
    accountId,
    name: normalizeOptionalString(merged.name),
    enabled,
    config: merged,
    credentialSource: inspected.source,
    configured: inspected.source !== "none",
  };
}
