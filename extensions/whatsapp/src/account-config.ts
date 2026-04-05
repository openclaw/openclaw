import {
  DEFAULT_ACCOUNT_ID,
  resolveAccountEntry,
  resolveMergedAccountConfig,
  type MullusiConfig,
} from "mullusi/plugin-sdk/account-core";
import type { WhatsAppAccountConfig } from "./runtime-api.js";

function resolveWhatsAppAccountConfig(
  cfg: MullusiConfig,
  accountId: string,
): WhatsAppAccountConfig | undefined {
  return resolveAccountEntry(cfg.channels?.whatsapp?.accounts, accountId);
}

export function resolveMergedWhatsAppAccountConfig(params: {
  cfg: MullusiConfig;
  accountId?: string | null;
}): WhatsAppAccountConfig & { accountId: string } {
  const rootCfg = params.cfg.channels?.whatsapp;
  const accountId = params.accountId?.trim() || rootCfg?.defaultAccount || DEFAULT_ACCOUNT_ID;
  const merged = resolveMergedAccountConfig<WhatsAppAccountConfig>({
    channelConfig: rootCfg as WhatsAppAccountConfig | undefined,
    accounts: rootCfg?.accounts as Record<string, Partial<WhatsAppAccountConfig>> | undefined,
    accountId,
    omitKeys: ["defaultAccount"],
  });
  return {
    accountId,
    ...merged,
  };
}
