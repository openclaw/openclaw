import { createAccountListHelpers, mergeAccountConfig } from "openclaw/plugin-sdk/account-helpers";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { BuzzAccountIdSchema, type BuzzConfig, type BuzzConfigInput } from "./config-schema.js";
import { parseBuzzTarget } from "./target.js";

function resolveChannelConfig(cfg: OpenClawConfig): BuzzConfigInput | undefined {
  return cfg.channels?.buzz;
}

export const {
  listAccountIds: listBuzzAccountIds,
  resolveDefaultAccountId: resolveDefaultBuzzAccountId,
} = createAccountListHelpers<BuzzConfigInput>("buzz", {
  normalizeAccountId,
  fallbackAccountIdWhenEmpty: false,
  implicitDefaultAccount: {
    channelKeys: ["relayUrl", "privateKey"],
    envVars: ["BUZZ_RELAY_URL", "BUZZ_PRIVATE_KEY"],
  },
});

export function resolveBuzzAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): { accountId: string; config: BuzzConfig; configPath: string; allowEnv: boolean } {
  const requestedId = params.accountId?.trim();
  const accountId = requestedId
    ? normalizeOptionalAccountId(requestedId)
    : resolveDefaultBuzzAccountId(params.cfg);
  if (!accountId || !BuzzAccountIdSchema.safeParse(accountId).success) {
    throw new Error("Buzz account ID must be a valid account key");
  }
  const root = resolveChannelConfig(params.cfg) ?? {};
  const allowEnv =
    accountId === DEFAULT_ACCOUNT_ID && !Object.hasOwn(root.accounts ?? {}, accountId);
  const account = allowEnv ? undefined : root.accounts?.[accountId];
  // Nested accounts own complete identities and room selection; only policy inherits.
  const merged = mergeAccountConfig<BuzzConfigInput>({
    channelConfig: root,
    accountConfig: account,
    omitKeys: [
      "defaultAccount",
      ...(allowEnv ? [] : ["name", "relayUrl", "privateKey", "authTag", "groups", "defaultTo"]),
    ],
  });
  return {
    accountId,
    allowEnv,
    configPath: allowEnv ? "channels.buzz" : `channels.buzz.accounts.${accountId}`,
    config: {
      ...merged,
      groupPolicy: merged.groupPolicy ?? "allowlist",
      enabled: root.enabled !== false && account?.enabled !== false,
      groups: normalizeBuzzGroups(merged.groups),
    },
  };
}

function normalizeBuzzGroups(groups: BuzzConfigInput["groups"]): BuzzConfig["groups"] {
  if (!groups) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(groups).map(([channelId, group]) => [parseBuzzTarget(channelId), group]),
  );
}
