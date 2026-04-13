import {
  type GroupPolicy,
  normalizeNonTelegramGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
} from "openclaw/plugin-sdk/config-runtime";

export function resolveWhatsAppRuntimeGroupPolicy(params: {
  providerConfigPresent: boolean;
  groupPolicy?: GroupPolicy;
  defaultGroupPolicy?: GroupPolicy;
}): {
  groupPolicy: "open" | "allowlist" | "disabled";
  providerMissingFallbackApplied: boolean;
} {
  // "members" is Telegram-only; treat it as "open" for WhatsApp.
  const resolved = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.providerConfigPresent,
    groupPolicy: params.groupPolicy && normalizeNonTelegramGroupPolicy(params.groupPolicy),
    defaultGroupPolicy:
      params.defaultGroupPolicy && normalizeNonTelegramGroupPolicy(params.defaultGroupPolicy),
  });
  return {
    groupPolicy: normalizeNonTelegramGroupPolicy(resolved.groupPolicy),
    providerMissingFallbackApplied: resolved.providerMissingFallbackApplied,
  };
}
