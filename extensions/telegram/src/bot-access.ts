// Telegram plugin module implements bot access behavior.
import {
  firstDefined,
  isSenderIdAllowed,
  mergeDmAllowFromSources,
} from "openclaw/plugin-sdk/allow-from";
import type {
  DmPolicy,
  TelegramDirectConfig,
  TelegramGroupConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { createDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";

export type NormalizedAllowFrom = {
  entries: string[];
  hasWildcard: boolean;
  hasEntries: boolean;
  invalidEntries: string[];
};

const MAX_WARNED_INVALID_ENTRIES = 256;
// Retain warn-once state for recently seen invalid entries without letting
// config churn accumulate keys for the process lifetime. LRU eviction
// intentionally lets long-evicted invalid entries warn again.
const warnedInvalidEntries = createDedupeCache({
  ttlMs: 0,
  maxSize: MAX_WARNED_INVALID_ENTRIES,
});
const log = createSubsystemLogger("telegram/bot-access");

/** @internal Reset the invalid-entry warn dedupe state. Exported for tests only. */
export function resetInvalidAllowFromWarnings(): void {
  warnedInvalidEntries.clear();
}

function warnInvalidAllowFromEntries(entries: string[]) {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return;
  }
  for (const entry of entries) {
    if (warnedInvalidEntries.check(entry)) {
      continue;
    }
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
    warnInvalidAllowFromEntries(uniqueStrings(invalidEntries));
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

export function resolveTelegramEffectiveDmPolicy(params: {
  isGroup: boolean;
  groupConfig?: TelegramDirectConfig | TelegramGroupConfig;
  dmPolicy?: DmPolicy;
}): DmPolicy {
  if (!params.isGroup && params.groupConfig && "dmPolicy" in params.groupConfig) {
    return params.groupConfig.dmPolicy ?? params.dmPolicy ?? "pairing";
  }
  return params.dmPolicy ?? "pairing";
}

export const isSenderAllowed = (params: {
  allow: NormalizedAllowFrom;
  senderId?: string;
  senderUsername?: string;
}) => {
  const { allow, senderId } = params;
  return isSenderIdAllowed(allow, senderId, true);
};

export { firstDefined };
