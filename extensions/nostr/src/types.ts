import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
// Nostr type declarations define plugin contracts.
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { z } from "zod";
import type { NostrConfigSchema, NostrProfile } from "./config-schema.js";
import { DEFAULT_RELAYS } from "./default-relays.js";
import { getPublicKeyFromPrivate } from "./nostr-key-utils.js";
import { hasConfiguredNostrPrivateKey, resolveNostrPrivateKey } from "./private-key.js";

type NostrAccountConfig = z.input<typeof NostrConfigSchema>;

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

const {
  listAccountIds: listNostrAccountIds,
  resolveDefaultAccountId: resolveDefaultNostrAccountId,
} = createAccountListHelpers("nostr", {
  fallbackAccountIdWhenEmpty: false,
  resolveImplicitAccountId: (cfg) => {
    const account = cfg.channels?.nostr as NostrAccountConfig | undefined;
    return hasConfiguredNostrPrivateKey(account?.privateKey)
      ? (normalizeOptionalAccountId(account?.defaultAccount) ?? DEFAULT_ACCOUNT_ID)
      : undefined;
  },
});

export { listNostrAccountIds, resolveDefaultNostrAccountId };

/**
 * Resolve a Nostr account from config
 */
export function resolveNostrAccount(opts: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedNostrAccount {
  const accountId = normalizeAccountId(opts.accountId ?? resolveDefaultNostrAccountId(opts.cfg));
  const nostrCfg = (opts.cfg.channels as Record<string, unknown> | undefined)?.nostr as
    | NostrAccountConfig
    | undefined;

  const baseEnabled = nostrCfg?.enabled !== false;
  const privateKey = resolveNostrPrivateKey(nostrCfg?.privateKey);
  const configured = hasConfiguredNostrPrivateKey(nostrCfg?.privateKey);

  let publicKey = "";
  if (privateKey) {
    try {
      publicKey = getPublicKeyFromPrivate(privateKey);
    } catch {
      // Invalid key - leave publicKey empty, configured will indicate issues
    }
  }

  return {
    accountId,
    name: normalizeOptionalString(nostrCfg?.name),
    enabled: baseEnabled,
    configured,
    privateKey,
    publicKey,
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
