import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const RAFT_CHANNEL_ID = "raft" as const;

type RaftAccountConfig = {
  name?: string;
  enabled?: boolean;
  profile?: string;
  accounts?: Record<string, RaftAccountConfig>;
  defaultAccount?: string;
};

export type ResolvedRaftAccount = ReturnType<typeof resolveRaftAccount>;

const {
  listAccountIds: listRaftAccountIds,
  resolveDefaultAccountId: resolveDefaultRaftAccountId,
  resolveAccountConfig: resolveMergedRaftAccountConfig,
} = createAccountListHelpers<RaftAccountConfig>(RAFT_CHANNEL_ID, {
  normalizeAccountId,
  omitKeys: ["defaultAccount"],
  implicitDefaultAccount: {
    channelKeys: ["profile"],
    envVars: ["RAFT_PROFILE"],
  },
});

export { listRaftAccountIds, resolveDefaultRaftAccountId };

export function resolveRaftAccount(params: { cfg: OpenClawConfig; accountId?: string | null }) {
  const accountId = normalizeAccountId(params.accountId ?? resolveDefaultRaftAccountId(params.cfg));
  const channel = params.cfg.channels?.[RAFT_CHANNEL_ID] as RaftAccountConfig | undefined;
  const merged = resolveMergedRaftAccountConfig(params.cfg, accountId);
  const configuredProfile = normalizeOptionalString(merged.profile);
  const envProfile =
    accountId === DEFAULT_ACCOUNT_ID
      ? normalizeOptionalString(process.env.RAFT_PROFILE)
      : undefined;
  const profile = configuredProfile ?? envProfile ?? null;

  return {
    accountId,
    name: normalizeOptionalString(merged.name),
    enabled: channel?.enabled !== false && merged.enabled !== false,
    configured: Boolean(profile),
    profile,
  };
}
