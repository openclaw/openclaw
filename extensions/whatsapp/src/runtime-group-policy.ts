import {
  normalizeNonTelegramGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
} from "openclaw/plugin-sdk/config-runtime";
import type { GroupPolicy } from "openclaw/plugin-sdk/whatsapp";

export function resolveWhatsAppRuntimeGroupPolicy(params: {
  providerConfigPresent: boolean;
  groupPolicy?: GroupPolicy;
  defaultGroupPolicy?: GroupPolicy;
}): {
  groupPolicy: "open" | "allowlist" | "disabled";
  providerMissingFallbackApplied: boolean;
} {
  // "members" is Telegram-only; treat it as "open" for WhatsApp.
  const normalizedGroupPolicy = params.groupPolicy
    ? normalizeNonTelegramGroupPolicy(params.groupPolicy)
    : params.groupPolicy;
  const normalizedDefaultGroupPolicy = params.defaultGroupPolicy
    ? normalizeNonTelegramGroupPolicy(params.defaultGroupPolicy)
    : params.defaultGroupPolicy;
  return resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.providerConfigPresent,
    groupPolicy: normalizedGroupPolicy,
    defaultGroupPolicy: normalizedDefaultGroupPolicy,
  });
}
