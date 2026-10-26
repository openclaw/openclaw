import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "openclaw/plugin-sdk/account-id";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  getNostrConfig,
  resolveNostrAccountBase,
  type NostrConfigSource,
  type ResolvedNostrAccount,
} from "./accounts.js";
import { getPublicKeyFromPrivate } from "./nostr-key-utils.js";
import { hasConfiguredNostrPrivateKey } from "./private-key.js";

export type { ResolvedNostrAccount } from "./accounts.js";

const {
  listAccountIds: listNostrAccountIds,
  resolveDefaultAccountId: resolveDefaultNostrAccountId,
} = createAccountListHelpers("nostr", {
  fallbackAccountIdWhenEmpty: false,
  resolveImplicitAccountId: (cfg) => {
    const account = getNostrConfig(cfg);
    return hasConfiguredNostrPrivateKey(account?.privateKey)
      ? (normalizeOptionalAccountId(account?.defaultAccount) ?? DEFAULT_ACCOUNT_ID)
      : undefined;
  },
});

export { listNostrAccountIds, resolveDefaultNostrAccountId };

export function resolveNostrAccount(opts: {
  cfg: NostrConfigSource;
  accountId?: string | null;
}): ResolvedNostrAccount {
  const accountId = normalizeAccountId(
    opts.accountId ??
      resolveDefaultNostrAccountId({ channels: { nostr: getNostrConfig(opts.cfg) } }),
  );
  const account = resolveNostrAccountBase(opts.cfg, accountId);

  let publicKey = "";
  if (account.privateKey) {
    try {
      publicKey = getPublicKeyFromPrivate(account.privateKey);
    } catch {
      // Invalid key - leave publicKey empty, configured will indicate issues
    }
  }

  return {
    ...account,
    name: normalizeOptionalString(account.config.name),
    publicKey,
  };
}
