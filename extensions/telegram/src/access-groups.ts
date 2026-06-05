// Telegram plugin module implements access groups behavior.
import type { DmPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  expandAllowFromWithAccessGroups,
  parseAccessGroupAllowFromEntry,
} from "openclaw/plugin-sdk/security-runtime";
import {
  isSenderAllowed,
  normalizeAllowFrom,
  normalizeDmAllowFromWithStore,
  type NormalizedAllowFrom,
} from "./bot-access.js";
import {
  normalizeTelegramAllowFromEntries,
  type TelegramAllowFromEntry,
} from "./allow-from.js";

export async function expandTelegramAllowFromWithAccessGroups(params: {
  cfg?: OpenClawConfig;
  allowFrom?: readonly TelegramAllowFromEntry[];
  accountId?: string;
  senderId?: string;
}): Promise<string[]> {
  const allowFrom = normalizeTelegramAllowFromEntries(params.allowFrom ?? []);
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
            isSenderAllowed({
              allow: normalizeAllowFrom(allowEntries),
              senderId: candidateSenderId,
            }),
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
  allowFrom?: readonly TelegramAllowFromEntry[];
  groupAllowOverride?: readonly TelegramAllowFromEntry[];
  storeAllowFrom?: string[];
  dmPolicy?: DmPolicy;
  accountId?: string;
  senderId?: string;
}): Promise<{
  allowFrom?: readonly TelegramAllowFromEntry[];
  expandedAllowFrom: string[];
  effectiveAllow: NormalizedAllowFrom;
}> {
  const allowFrom = params.groupAllowOverride ?? params.allowFrom;
  const expandedAllowFrom = await expandTelegramAllowFromWithAccessGroups({
    cfg: params.cfg,
    allowFrom,
    accountId: params.accountId,
    senderId: params.senderId,
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
