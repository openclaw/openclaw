import {
  firstDefined,
  isSenderIdAllowed,
  mergeDmAllowFromSources,
  type AllowlistMatch,
} from "openclaw/plugin-sdk/allow-from";
import {
  parseAccessGroupAllowFromEntry,
  resolveAccessGroupAllowFromMatches,
} from "openclaw/plugin-sdk/command-auth";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

export type NormalizedAllowFrom = {
  entries: string[];
  hasWildcard: boolean;
  hasEntries: boolean;
  invalidEntries: string[];
};

type AllowFromMatch = AllowlistMatch<"wildcard" | "id">;

const warnedInvalidEntries = new Set<string>();
const log = createSubsystemLogger("telegram/bot-access");

function warnInvalidAllowFromEntries(entries: string[]) {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return;
  }
  for (const entry of entries) {
    if (warnedInvalidEntries.has(entry)) {
      continue;
    }
    warnedInvalidEntries.add(entry);
    log.warn(
      [
        "Invalid allowFrom entry:",
        JSON.stringify(entry),
        "- allowFrom/groupAllowFrom authorization expects numeric Telegram sender user IDs only.",
        'To allow a Telegram group or supergroup, add its negative chat ID under "channels.telegram.groups" instead.',
        'If you had "@username" entries, re-run setup (it resolves @username to IDs) or replace them manually.',
      ].join(" "),
    );
  }
}

export const normalizeAllowFrom = (list?: Array<string | number>): NormalizedAllowFrom => {
  const entries = (list ?? [])
    .map((value) => normalizeOptionalString(String(value)) ?? "")
    .filter(Boolean);
  const hasWildcard = entries.includes("*");
  const normalized = entries
    .filter((value) => value !== "*")
    .map((value) => value.replace(/^(telegram|tg):/i, ""));
  const invalidEntries = normalized.filter((value) => !/^\d+$/.test(value));
  if (invalidEntries.length > 0) {
    warnInvalidAllowFromEntries([...new Set(invalidEntries)]);
  }
  const ids = normalized.filter((value) => /^\d+$/.test(value));
  return {
    entries: ids,
    hasWildcard,
    hasEntries: entries.length > 0,
    invalidEntries,
  };
};

export const normalizeDmAllowFromWithStore = (params: {
  allowFrom?: Array<string | number>;
  storeAllowFrom?: string[];
  dmPolicy?: string;
}): NormalizedAllowFrom => normalizeAllowFrom(mergeDmAllowFromSources(params));

export const isSenderAllowed = (params: {
  allow: NormalizedAllowFrom;
  senderId?: string;
  senderUsername?: string;
}) => {
  const { allow, senderId } = params;
  return isSenderIdAllowed(allow, senderId, true);
};

export async function expandTelegramAllowFromWithAccessGroups(params: {
  cfg?: OpenClawConfig;
  allowFrom?: Array<string | number>;
  accountId?: string;
  senderId?: string;
}): Promise<string[]> {
  const allowFrom = (params.allowFrom ?? []).map(String);
  if (!params.senderId) {
    return allowFrom;
  }
  const matched = await resolveAccessGroupAllowFromMatches({
    cfg: params.cfg,
    allowFrom,
    channel: "telegram",
    accountId: params.accountId ?? "default",
    senderId: params.senderId,
    isSenderAllowed: (senderId, entries) =>
      isSenderAllowed({
        allow: normalizeAllowFrom(entries),
        senderId,
      }),
  });
  if (matched.length === 0) {
    return allowFrom;
  }
  const matchedGroups = new Set(matched);
  const expanded = allowFrom.filter((entry) => {
    const groupName = parseAccessGroupAllowFromEntry(entry);
    return groupName == null || !matchedGroups.has(`accessGroup:${groupName}`);
  });
  return Array.from(new Set([...expanded, params.senderId]));
}

export { firstDefined };

export const resolveSenderAllowMatch = (params: {
  allow: NormalizedAllowFrom;
  senderId?: string;
  senderUsername?: string;
}): AllowFromMatch => {
  const { allow, senderId } = params;
  if (allow.hasWildcard) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }
  if (!allow.hasEntries) {
    return { allowed: false };
  }
  if (senderId && allow.entries.includes(senderId)) {
    return { allowed: true, matchKey: senderId, matchSource: "id" };
  }
  return { allowed: false };
};
