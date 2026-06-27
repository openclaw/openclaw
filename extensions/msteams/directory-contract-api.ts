// Msteams API module exposes the plugin public contract.
import type { ChannelDirectoryAdapter } from "openclaw/plugin-sdk/channel-contract";
import { listDirectoryEntriesFromSources } from "openclaw/plugin-sdk/directory-runtime";
import { resolveMSTeamsAccountConfig } from "./src/accounts.js";
import { normalizeMSTeamsMessagingTarget } from "./src/resolve-allowlist.js";
import { resolveMSTeamsCredentials } from "./src/token.js";

const msteamsDirectoryContractAdapter: ChannelDirectoryAdapter = {
  self: async ({ cfg, accountId }) => {
    const msteamsCfg = resolveMSTeamsAccountConfig(cfg, accountId);
    const creds = resolveMSTeamsCredentials(msteamsCfg);
    return creds ? { kind: "user" as const, id: creds.appId, name: creds.appId } : null;
  },
  listPeers: async ({ cfg, accountId, query, limit }) => {
    const msteamsCfg = resolveMSTeamsAccountConfig(cfg, accountId);
    return listDirectoryEntriesFromSources({
      kind: "user",
      sources: [msteamsCfg.allowFrom ?? [], Object.keys(msteamsCfg.dms ?? {})],
      query,
      limit,
      normalizeId: (raw) => {
        const normalized = normalizeMSTeamsMessagingTarget(raw) ?? raw;
        const lowered = normalized.toLowerCase();
        return lowered.startsWith("user:") || lowered.startsWith("conversation:")
          ? normalized
          : `user:${normalized}`;
      },
    });
  },
  listGroups: async ({ cfg, accountId, query, limit }) => {
    const msteamsCfg = resolveMSTeamsAccountConfig(cfg, accountId);
    return listDirectoryEntriesFromSources({
      kind: "group",
      sources: [
        Object.values(msteamsCfg.teams ?? {}).flatMap((team) => Object.keys(team.channels ?? {})),
      ],
      query,
      limit,
      normalizeId: (raw) => `conversation:${raw.replace(/^conversation:/i, "").trim()}`,
    });
  },
};

export const msteamsDirectoryContractPlugin = {
  id: "msteams",
  directory: msteamsDirectoryContractAdapter,
};
