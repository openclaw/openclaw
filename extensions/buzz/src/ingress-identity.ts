import type { StableChannelIngressIdentityParams } from "openclaw/plugin-sdk/channel-ingress-runtime";

export const buzzIngressIdentity = {
  key: "buzz-pubkey",
  // The relay client drops every event whose signature does not verify against its pubkey.
  authentication: "verified",
  entryIdPrefix: "buzz-entry",
} satisfies StableChannelIngressIdentityParams;
