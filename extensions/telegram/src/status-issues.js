import {
  appendMatchMetadata,
  asString,
  isRecord,
  resolveEnabledConfiguredAccountId
} from "../../../src/channels/plugins/status-issues/shared.js";
function readTelegramAccountStatus(value) {
  if (!isRecord(value)) {
    return null;
  }
  return {
    accountId: value.accountId,
    enabled: value.enabled,
    configured: value.configured,
    allowUnmentionedGroups: value.allowUnmentionedGroups,
    audit: value.audit
  };
}
function readTelegramGroupMembershipAuditSummary(value) {
  if (!isRecord(value)) {
    return {};
  }
  const unresolvedGroups = typeof value.unresolvedGroups === "number" && Number.isFinite(value.unresolvedGroups) ? value.unresolvedGroups : void 0;
  const hasWildcardUnmentionedGroups = typeof value.hasWildcardUnmentionedGroups === "boolean" ? value.hasWildcardUnmentionedGroups : void 0;
  const groupsRaw = value.groups;
  const groups = Array.isArray(groupsRaw) ? groupsRaw.map((entry) => {
    if (!isRecord(entry)) {
      return null;
    }
    const chatId = asString(entry.chatId);
    if (!chatId) {
      return null;
    }
    const ok = typeof entry.ok === "boolean" ? entry.ok : void 0;
    const status = asString(entry.status) ?? null;
    const error = asString(entry.error) ?? null;
    const matchKey = asString(entry.matchKey) ?? void 0;
    const matchSource = asString(entry.matchSource) ?? void 0;
    return { chatId, ok, status, error, matchKey, matchSource };
  }).filter(Boolean) : void 0;
  return { unresolvedGroups, hasWildcardUnmentionedGroups, groups };
}
function collectTelegramStatusIssues(accounts) {
  const issues = [];
  for (const entry of accounts) {
    const account = readTelegramAccountStatus(entry);
    if (!account) {
      continue;
    }
    const accountId = resolveEnabledConfiguredAccountId(account);
    if (!accountId) {
      continue;
    }
    if (account.allowUnmentionedGroups === true) {
      issues.push({
        channel: "telegram",
        accountId,
        kind: "config",
        message: "Config allows unmentioned group messages (requireMention=false). Telegram Bot API privacy mode will block most group messages unless disabled.",
        fix: "In BotFather run /setprivacy \u2192 Disable for this bot (then restart the gateway)."
      });
    }
    const audit = readTelegramGroupMembershipAuditSummary(account.audit);
    if (audit.hasWildcardUnmentionedGroups === true) {
      issues.push({
        channel: "telegram",
        accountId,
        kind: "config",
        message: 'Telegram groups config uses "*" with requireMention=false; membership probing is not possible without explicit group IDs.',
        fix: "Add explicit numeric group ids under channels.telegram.groups (or per-account groups) to enable probing."
      });
    }
    if (audit.unresolvedGroups && audit.unresolvedGroups > 0) {
      issues.push({
        channel: "telegram",
        accountId,
        kind: "config",
        message: `Some configured Telegram groups are not numeric IDs (unresolvedGroups=${audit.unresolvedGroups}). Membership probe can only check numeric group IDs.`,
        fix: "Use numeric chat IDs (e.g. -100...) as keys in channels.telegram.groups for requireMention=false groups."
      });
    }
    for (const group of audit.groups ?? []) {
      if (group.ok === true) {
        continue;
      }
      const status = group.status ? ` status=${group.status}` : "";
      const err = group.error ? `: ${group.error}` : "";
      const baseMessage = `Group ${group.chatId} not reachable by bot.${status}${err}`;
      issues.push({
        channel: "telegram",
        accountId,
        kind: "runtime",
        message: appendMatchMetadata(baseMessage, {
          matchKey: group.matchKey,
          matchSource: group.matchSource
        }),
        fix: "Invite the bot to the group, then DM the bot once (/start) and restart the gateway."
      });
    }
  }
  return issues;
}
export {
  collectTelegramStatusIssues
};
