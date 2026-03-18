import {
  listInspectedDirectoryEntriesFromSources,
  type DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-runtime";
import { inspectSlackAccount, type InspectedSlackAccount } from "../api.js";
import { parseSlackTarget } from "./targets.js";

export async function listSlackDirectoryPeersFromConfig(params: DirectoryConfigParams) {
  return listInspectedDirectoryEntriesFromSources({
    ...params,
    kind: "user",
    inspectAccount: (cfg, accountId) =>
      inspectSlackAccount({ cfg, accountId }) as InspectedSlackAccount | null,
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
  return listInspectedDirectoryEntriesFromSources({
    ...params,
    kind: "group",
    inspectAccount: (cfg, accountId) =>
      inspectSlackAccount({ cfg, accountId }) as InspectedSlackAccount | null,
    resolveSources: (account) => [Object.keys(account.config.channels ?? {})],
    normalizeId: (raw) => {
      const normalized = parseSlackTarget(raw, { defaultKind: "channel" });
      return normalized?.kind === "channel" ? `channel:${normalized.id.toLowerCase()}` : null;
    },
  });
}
