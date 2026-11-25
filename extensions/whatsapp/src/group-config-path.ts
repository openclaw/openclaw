import {
  DEFAULT_ACCOUNT_ID,
  resolveAccountKey,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import type { WhatsAppAccountConfig } from "./account-types.js";

const WHATSAPP_GROUP_SCOPE_FIELDS = ["groupPolicy", "groupAllowFrom", "groups"] as const;

type WhatsAppGroupScopeField = (typeof WHATSAPP_GROUP_SCOPE_FIELDS)[number];

function resolveWhatsAppGroupScopeBasePath(
  params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  },
  fields: readonly WhatsAppGroupScopeField[] = WHATSAPP_GROUP_SCOPE_FIELDS,
): string | undefined {
  const accountId = params.accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const whatsapp = params.cfg.channels?.whatsapp;
  const accounts = whatsapp?.accounts;
  const accountKey = resolveAccountKey(accounts, accountId);
  const defaultAccountKey = resolveAccountKey(accounts, DEFAULT_ACCOUNT_ID);
  const accountConfig = accountKey ? accounts?.[accountKey] : undefined;
  const defaultAccountConfig = defaultAccountKey ? accounts?.[defaultAccountKey] : undefined;
  const hasField = (config: WhatsAppAccountConfig | undefined) =>
    fields.some((field) => config?.[field] !== undefined);
  if (hasField(accountConfig)) {
    return `channels.whatsapp.accounts.${accountKey}`;
  }
  if (accountId !== DEFAULT_ACCOUNT_ID && hasField(defaultAccountConfig)) {
    return `channels.whatsapp.accounts.${defaultAccountKey}`;
  }
  if (hasField(whatsapp)) {
    return "channels.whatsapp";
  }
  return undefined;
}

export function resolveWhatsAppConfigPath(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  field: WhatsAppGroupScopeField;
}): string {
  return `${resolveWhatsAppGroupScopeBasePath(params) ?? "channels.whatsapp"}.${params.field}`;
}

export function resolveWhatsAppGroupsConfigPath(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string {
  return `${
    resolveWhatsAppGroupScopeBasePath(params, ["groups"]) ??
    resolveWhatsAppGroupScopeBasePath(params) ??
    "channels.whatsapp"
  }.groups`;
}
