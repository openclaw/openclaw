import {
  resolveMergedAccountConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import { resolveDefaultWhatsAppAccountId } from "./accounts.js";
import type { WhatsAppAccountConfig } from "./runtime-api.js";

/**
 * Resolve the `allowOutboundTo` list from the WhatsApp channel config.
 * This list permits outbound sends to targets that may not be in `allowFrom`,
 * keeping inbound DM gating separate from outbound message permissions.
 */
export function resolveAllowOutboundTo(
  cfg: OpenClawConfig | undefined,
  accountId?: string | null,
): string[] | undefined {
  if (!cfg) {
    return undefined;
  }
  const rootCfg = cfg.channels?.whatsapp;
  if (!rootCfg) {
    return undefined;
  }
  const effectiveAccountId = accountId?.trim() || resolveDefaultWhatsAppAccountId(cfg);
  const merged = resolveMergedAccountConfig<WhatsAppAccountConfig>({
    channelConfig: rootCfg as WhatsAppAccountConfig | undefined,
    accounts: rootCfg?.accounts as Record<string, Partial<WhatsAppAccountConfig>> | undefined,
    accountId: effectiveAccountId,
    omitKeys: ["defaultAccount"],
  });
  return (merged as Record<string, unknown>).allowOutboundTo as string[] | undefined;
}
