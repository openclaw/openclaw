import {
  applyDirectoryQueryAndLimit,
  listDirectoryGroupEntriesFromMapKeysAndAllowFrom,
  listDirectoryUserEntriesFromAllowFrom,
  listDirectoryUserEntriesFromAllowFromAndMapKeys,
  type DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-runtime";
import { resolveFeishuAccount } from "./accounts.js";
import { isFeishuGroupReadAllowed } from "./read-policy.js";
import { normalizeFeishuTarget } from "./targets.js";

export type FeishuDirectoryPeer = {
  kind: "user";
  id: string;
  name?: string;
};

export type FeishuDirectoryGroup = {
  kind: "group";
  id: string;
  name?: string;
};

export async function listFeishuDirectoryPeers(
  params: DirectoryConfigParams,
): Promise<FeishuDirectoryPeer[]> {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  const entries = listDirectoryUserEntriesFromAllowFromAndMapKeys({
    allowFrom: account.config.allowFrom,
    map: account.config.dms,
    query: params.query,
    limit: params.limit,
    normalizeAllowFromId: (entry) => normalizeFeishuTarget(entry) ?? entry,
    normalizeMapKeyId: (entry) => normalizeFeishuTarget(entry) ?? entry,
  });
  return entries.map(({ id }) => ({ kind: "user", id }));
}

export async function listFeishuDirectoryGroups(
  params: DirectoryConfigParams,
): Promise<FeishuDirectoryGroup[]> {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  const entries = listDirectoryGroupEntriesFromMapKeysAndAllowFrom({
    groups: account.config.groups,
    allowFrom: account.config.groupAllowFrom,
    query: params.query,
    limit: params.limit,
  });
  return entries.map(({ id }) => ({ kind: "group", id }));
}

export async function listAuthorizedFeishuDirectoryPeers(
  params: DirectoryConfigParams,
): Promise<FeishuDirectoryPeer[]> {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  const entries = listDirectoryUserEntriesFromAllowFrom({
    allowFrom: account.config.allowFrom,
    query: params.query,
    limit: params.limit,
    normalizeId: (entry) => normalizeFeishuTarget(entry) ?? entry,
  });
  return entries.map(({ id }) => ({ kind: "user", id }));
}

export async function listAuthorizedFeishuDirectoryGroups(
  params: DirectoryConfigParams,
): Promise<FeishuDirectoryGroup[]> {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  const enabledGroups = Object.fromEntries(
    Object.entries(account.config.groups ?? {}).filter(([, group]) => group?.enabled !== false),
  );
  const entries = listDirectoryGroupEntriesFromMapKeysAndAllowFrom({
    groups: enabledGroups,
    allowFrom: account.config.groupAllowFrom,
  });
  const authorizedEntries = entries.filter((entry) =>
    isFeishuGroupReadAllowed(params.cfg, account, entry.id, false),
  );
  return applyDirectoryQueryAndLimit(
    authorizedEntries.map((entry) => entry.id),
    params,
  ).map((id) => ({ kind: "group", id }));
}
