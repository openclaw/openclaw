import type { StableChannelIngressIdentityParams } from "openclaw/plugin-sdk/channel-ingress-runtime";

export { resolveOpenProviderRuntimeGroupPolicy as resolveZaloRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";

const ZALO_ALLOW_FROM_PREFIX_RE = /^(zalo|zl):/i;

function normalizeZaloAllowEntry(value: string): string {
  return value.trim().replace(ZALO_ALLOW_FROM_PREFIX_RE, "").trim().toLowerCase();
}

export const zaloIngressIdentity = {
  key: "zalo-user-id",
  // Bot API updates come from the secret-token webhook or token-authenticated polling.
  authentication: "verified",
  normalize: normalizeZaloAllowEntry,
  sensitivity: "pii",
  entryIdPrefix: "zalo-entry",
} satisfies StableChannelIngressIdentityParams;
