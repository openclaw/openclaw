import type { GroupPolicy } from "openclaw/plugin-sdk";

export type ZulipAccountConfig = {
  name?: string;
  enabled?: boolean;

  // Auth
  realm?: string; // preferred (ZULIP_REALM)
  site?: string; // alias for realm
  email?: string;
  apiKey?: string;

  // Access control
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  groupPolicy?: GroupPolicy;

  // Optional: keep a lightweight DM policy; defaults to pairing.
  dmPolicy?: "disabled" | "pairing" | "allowlist" | "open";
};

export type CoreConfig = {
  channels?: {
    defaults?: {
      groupPolicy?: GroupPolicy;
    };
    zulip?: ZulipAccountConfig & {
      accounts?: Record<string, ZulipAccountConfig | undefined>;
    };
  };
};
