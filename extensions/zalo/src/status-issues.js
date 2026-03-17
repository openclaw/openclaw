import { coerceStatusIssueAccountId, readStatusIssueFields } from "../../shared/status-issues.js";
const ZALO_STATUS_FIELDS = ["accountId", "enabled", "configured", "dmPolicy"];
function collectZaloStatusIssues(accounts) {
  const issues = [];
  for (const entry of accounts) {
    const account = readStatusIssueFields(entry, ZALO_STATUS_FIELDS);
    if (!account) {
      continue;
    }
    const accountId = coerceStatusIssueAccountId(account.accountId) ?? "default";
    const enabled = account.enabled !== false;
    const configured = account.configured === true;
    if (!enabled || !configured) {
      continue;
    }
    if (account.dmPolicy === "open") {
      issues.push({
        channel: "zalo",
        accountId,
        kind: "config",
        message: 'Zalo dmPolicy is "open", allowing any user to message the bot without pairing.',
        fix: 'Set channels.zalo.dmPolicy to "pairing" or "allowlist" to restrict access.'
      });
    }
  }
  return issues;
}
export {
  collectZaloStatusIssues
};
