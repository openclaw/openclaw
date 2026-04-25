import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";

export function isWhatsAppReadOnly(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return resolveWhatsAppAccount(params).readOnly;
}

export function assertWhatsAppWritable(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  action?: string;
}): void {
  if (!isWhatsAppReadOnly(params)) {
    return;
  }
  const accountSuffix = params.accountId?.trim() ? ` for account ${params.accountId}` : "";
  const action = params.action?.trim() || "send";
  throw new Error(`WhatsApp readOnly mode blocks outbound ${action}${accountSuffix}.`);
}

export function createWhatsAppReadOnlySendError(params: { accountId?: string | null }): Error {
  const accountSuffix = params.accountId?.trim() ? ` for account ${params.accountId}` : "";
  return new Error(`WhatsApp readOnly mode blocks outbound sends${accountSuffix}.`);
}
