// Whatsapp helper module supports config accessors behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveWhatsAppAccount } from "./accounts.js";
export { formatWhatsAppConfigAllowFromEntries } from "./allowlist-format.js";

export function resolveWhatsAppConfigAllowFrom(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  return [...(resolveWhatsAppAccount(params).allowFrom ?? [])];
}

export function resolveWhatsAppConfigDefaultTo(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string | undefined {
  const defaultTo = resolveWhatsAppAccount(params).defaultTo?.trim();
  return defaultTo || undefined;
}
