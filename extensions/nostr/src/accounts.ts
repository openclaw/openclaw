import type { PluginRuntime } from "openclaw/plugin-sdk/channel-plugin-common";
import type { z } from "zod";
import type { NostrConfigSchema, NostrProfile } from "./config-schema.js";
import { DEFAULT_RELAYS } from "./default-relays.js";
import { hasConfiguredNostrPrivateKey, resolveNostrPrivateKey } from "./private-key.js";

type NostrAccountConfig = z.input<typeof NostrConfigSchema>;
export type NostrConfigSource = Pick<ReturnType<PluginRuntime["config"]["current"]>, "channels">;

export interface ResolvedNostrAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  privateKey: string;
  publicKey: string;
  relays: string[];
  profile?: NostrProfile;
  config: NostrAccountConfig;
}

export function getNostrConfig(cfg: NostrConfigSource): NostrAccountConfig | undefined {
  return cfg.channels?.nostr;
}

// Setup shares the account projection without loading runtime public-key derivation.
export function resolveNostrAccountBase(
  cfg: NostrConfigSource,
  accountId: string,
): ResolvedNostrAccount {
  const nostrCfg = getNostrConfig(cfg);
  const privateKey = resolveNostrPrivateKey(nostrCfg?.privateKey);
  return {
    accountId,
    name: typeof nostrCfg?.name === "string" ? nostrCfg.name : undefined,
    enabled: nostrCfg?.enabled !== false,
    configured: hasConfiguredNostrPrivateKey(nostrCfg?.privateKey),
    privateKey,
    publicKey: "",
    relays: nostrCfg?.relays ?? DEFAULT_RELAYS,
    profile: nostrCfg?.profile,
    config: {
      enabled: nostrCfg?.enabled,
      name: nostrCfg?.name,
      privateKey: nostrCfg?.privateKey,
      relays: nostrCfg?.relays,
      dmPolicy: nostrCfg?.dmPolicy,
      allowFrom: nostrCfg?.allowFrom,
      profile: nostrCfg?.profile,
    },
  };
}
