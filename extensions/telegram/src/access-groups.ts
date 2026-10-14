import { isSenderIdAllowed } from "openclaw/plugin-sdk/allow-from";
import type { DmPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  expandAllowFromWithAccessGroups,
  parseAccessGroupAllowFromEntry,
} from "openclaw/plugin-sdk/security-runtime";
import {
  normalizeAllowFrom,
  normalizeDmAllowFromWithStore,
  type NormalizedAllowFrom,
} from "./bot-access.js";

export async function expandTelegramAllowFromWithAccessGroups(params: {
  cfg?: OpenClawConfig;
  allowFrom?: Array<string | number>;
  accountId?: string;
  senderId?: string;
}): Promise<string[]> {
  const allowFrom = (params.allowFrom ?? []).map(String);
  const senderId = params.senderId?.trim() ?? "";
  const expanded =
    params.cfg && senderId
      ? await expandAllowFromWithAccessGroups({
          cfg: params.cfg,
          allowFrom,
          channel: "telegram",
          accountId: params.accountId ?? "default",
          senderId,
          isSenderAllowed: (candidateSenderId, allowEntries) =>
            isSenderIdAllowed(normalizeAllowFrom(allowEntries), candidateSenderId, true),
        })
      : allowFrom;
  const originalEntries = new Set(allowFrom);
  const matched = expanded.some((entry) => !originalEntries.has(entry));
  return matched
    ? expanded.filter((entry) => parseAccessGroupAllowFromEntry(entry) == null)
    : expanded;
}

export async function resolveTelegramDmAllow(params: {
  cfg?: OpenClawConfig;
  allowFrom?: Array<string | number>;
  groupAllowOverride?: Array<string | number>;
  storeAllowFrom?: string[];
  dmPolicy?: DmPolicy;
  accountId?: string;
  senderId?: string;
}): Promise<{
  allowFrom?: Array<string | number>;
  expandedAllowFrom: string[];
  effectiveAllow: NormalizedAllowFrom;
}> {
  const allowFrom = params.groupAllowOverride ?? params.allowFrom;
  const expandedAllowFrom = await expandTelegramAllowFromWithAccessGroups({
    ...params,
    allowFrom,
  });
  return {
    allowFrom,
    expandedAllowFrom,
    effectiveAllow: normalizeDmAllowFromWithStore({
      allowFrom: expandedAllowFrom,
      storeAllowFrom: params.storeAllowFrom,
      dmPolicy: params.dmPolicy,
    }),
  };
}
