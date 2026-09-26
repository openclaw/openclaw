import {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
} from "openclaw/plugin-sdk/runtime-group-policy";

type FeishuRuntimeGroupPolicyConfig = {
  channels?: {
    feishu?: unknown;
    defaults?: {
      groupPolicy?: "open" | "allowlist" | "disabled";
    };
  };
};

/** Resolve Feishu runtime group policy with the declared allowlist fallback. */
export function resolveFeishuRuntimeGroupPolicy(params: {
  cfg: FeishuRuntimeGroupPolicyConfig;
  groupPolicy?: "open" | "allowlist" | "disabled";
}): {
  groupPolicy: "open" | "allowlist" | "disabled";
  providerMissingFallbackApplied: boolean;
} {
  return resolveAllowlistProviderRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.feishu !== undefined,
    groupPolicy: params.groupPolicy,
    defaultGroupPolicy: resolveDefaultGroupPolicy(params.cfg),
  });
}
