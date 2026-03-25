import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import {
  listResolvedDirectoryEntriesFromSources,
  type DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-runtime";
import { mergeSlackAccountConfig, resolveDefaultSlackAccountId } from "./accounts.js";
import { parseSlackTarget } from "./targets.js";

function resolveSlackDirectoryConfigAccount(
  cfg: DirectoryConfigParams["cfg"],
  accountId?: string | null,
) {
  const resolvedAccountId = normalizeAccountId(accountId ?? resolveDefaultSlackAccountId(cfg));
  const config = mergeSlackAccountConfig(cfg, resolvedAccountId);
  return {
    accountId: resolvedAccountId,
    config,
    dm: config.dm,
  };
}

export async function listSlackDirectoryPeersFromConfig(params: DirectoryConfigParams) {
  return listResolvedDirectoryEntriesFromSources({
    ...params,
    kind: "user",
    resolveAccount: (cfg, accountId) => resolveSlackDirectoryConfigAccount(cfg, accountId),
    resolveSources: (account) => {
      const allowFrom = account.config.allowFrom ?? account.dm?.allowFrom ?? [];
      const channelUsers = Object.values(account.config.channels ?? {}).flatMap(
        (channel) => channel.users ?? [],
      );
      return [allowFrom, Object.keys(account.config.dms ?? {}), channelUsers];
    },
    normalizeId: (raw) => {
      const mention = raw.match(/^<@([A-Z0-9]+)>$/i);
      const normalizedUserId = (mention?.[1] ?? raw).replace(/^(slack|user):/i, "").trim();
      if (!normalizedUserId) {
        return null;
      }
      const target = `user:${normalizedUserId}`;
      const normalized = parseSlackTarget(target, { defaultKind: "user" });
      return normalized?.kind === "user" ? `user:${normalized.id.toLowerCase()}` : null;
    },
  });
}

export async function listSlackDirectoryGroupsFromConfig(params: DirectoryConfigParams) {
  return listResolvedDirectoryEntriesFromSources({
    ...params,
    kind: "group",
    resolveAccount: (cfg, accountId) => resolveSlackDirectoryConfigAccount(cfg, accountId),
    resolveSources: (account) => [Object.keys(account.config.channels ?? {})],
    normalizeId: (raw) => {
      const normalized = parseSlackTarget(raw, { defaultKind: "channel" });
      return normalized?.kind === "channel" ? `channel:${normalized.id.toLowerCase()}` : null;
    },
  });
}
