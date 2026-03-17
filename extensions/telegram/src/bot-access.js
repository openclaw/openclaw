import {
  firstDefined,
  isSenderIdAllowed,
  mergeDmAllowFromSources
} from "../../../src/channels/allow-from.js";
import { createSubsystemLogger } from "../../../src/logging/subsystem.js";
const warnedInvalidEntries = /* @__PURE__ */ new Set();
const log = createSubsystemLogger("telegram/bot-access");
function warnInvalidAllowFromEntries(entries) {
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
        'If you had "@username" entries, re-run onboarding (it resolves @username to IDs) or replace them manually.'
      ].join(" ")
    );
  }
}
const normalizeAllowFrom = (list) => {
  const entries = (list ?? []).map((value) => String(value).trim()).filter(Boolean);
  const hasWildcard = entries.includes("*");
  const normalized = entries.filter((value) => value !== "*").map((value) => value.replace(/^(telegram|tg):/i, ""));
  const invalidEntries = normalized.filter((value) => !/^\d+$/.test(value));
  if (invalidEntries.length > 0) {
    warnInvalidAllowFromEntries([...new Set(invalidEntries)]);
  }
  const ids = normalized.filter((value) => /^\d+$/.test(value));
  return {
    entries: ids,
    hasWildcard,
    hasEntries: entries.length > 0,
    invalidEntries
  };
};
const normalizeDmAllowFromWithStore = (params) => normalizeAllowFrom(mergeDmAllowFromSources(params));
const isSenderAllowed = (params) => {
  const { allow, senderId } = params;
  return isSenderIdAllowed(allow, senderId, true);
};
const resolveSenderAllowMatch = (params) => {
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
export {
  firstDefined,
  isSenderAllowed,
  normalizeAllowFrom,
  normalizeDmAllowFromWithStore,
  resolveSenderAllowMatch
};
