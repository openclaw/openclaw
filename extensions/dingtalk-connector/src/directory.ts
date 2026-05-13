import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { resolveDingtalkAccount } from "./config/accounts.ts";
import { normalizeDingtalkTarget } from "./targets.ts";

export type DingtalkDirectoryPeer = {
  kind: "user";
  id: string;
  name?: string;
};

export type DingtalkDirectoryGroup = {
  kind: "group";
  id: string;
  name?: string;
};

export async function listDingtalkDirectoryPeers(params: {
  cfg: ClawdbotConfig;
  query?: string;
  limit?: number;
  accountId?: string;
}): Promise<DingtalkDirectoryPeer[]> {
  const account = resolveDingtalkAccount({ cfg: params.cfg, accountId: params.accountId });
  const dingtalkCfg = account.config;
  const q = params.query?.trim().toLowerCase() || "";
  const ids = new Set<string>();

  for (const entry of dingtalkCfg?.allowFrom ?? []) {
    const trimmed = String(entry).trim();
    if (trimmed && trimmed !== "*") {
      ids.add(trimmed);
    }
  }

  return Array.from(ids)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => normalizeDingtalkTarget(raw) ?? raw)
    .filter((id) => (q ? id.toLowerCase().includes(q) : true))
    .slice(0, params.limit && params.limit > 0 ? params.limit : undefined)
    .map((id) => ({ kind: "user" as const, id }));
}

export async function listDingtalkDirectoryGroups(params: {
  cfg: ClawdbotConfig;
  query?: string;
  limit?: number;
  accountId?: string;
}): Promise<DingtalkDirectoryGroup[]> {
  const account = resolveDingtalkAccount({ cfg: params.cfg, accountId: params.accountId });
  const dingtalkCfg = account.config;
  const q = params.query?.trim().toLowerCase() || "";
  const ids = new Set<string>();

  for (const groupId of Object.keys(dingtalkCfg?.groups ?? {})) {
    const trimmed = groupId.trim();
    if (trimmed && trimmed !== "*") {
      ids.add(trimmed);
    }
  }

  for (const entry of dingtalkCfg?.groupAllowFrom ?? []) {
    const trimmed = String(entry).trim();
    if (trimmed && trimmed !== "*") {
      ids.add(trimmed);
    }
  }

  return Array.from(ids)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .filter((id) => (q ? id.toLowerCase().includes(q) : true))
    .slice(0, params.limit && params.limit > 0 ? params.limit : undefined)
    .map((id) => ({ kind: "group" as const, id }));
}

export async function listDingtalkDirectoryPeersLive(params: {
  cfg: ClawdbotConfig;
  query?: string;
  limit?: number;
  accountId?: string;
}): Promise<DingtalkDirectoryPeer[]> {
  // DingTalk doesn't have a public API to list users, so we fall back to static list
  return listDingtalkDirectoryPeers(params);
}

export async function listDingtalkDirectoryGroupsLive(params: {
  cfg: ClawdbotConfig;
  query?: string;
  limit?: number;
  accountId?: string;
}): Promise<DingtalkDirectoryGroup[]> {
  // DingTalk doesn't have a public API to list groups, so we fall back to static list
  return listDingtalkDirectoryGroups(params);
}
