import type { ChannelAccountSnapshot, ChannelStatusIssue } from "clawdbot/plugin-sdk";

export function collectKakaoStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];

  for (const account of accounts) {
    if (!account.configured) {
      issues.push({
        level: "error",
        message: `KakaoWork account "${account.accountId}" is not configured (missing app key)`,
        accountId: account.accountId,
      });
      continue;
    }

    if (!account.enabled) {
      issues.push({
        level: "warn",
        message: `KakaoWork account "${account.accountId}" is disabled`,
        accountId: account.accountId,
      });
      continue;
    }

    if (account.lastError) {
      issues.push({
        level: "error",
        message: `KakaoWork account "${account.accountId}" error: ${account.lastError}`,
        accountId: account.accountId,
      });
    }

    const probe = account.probe as { ok?: boolean; error?: string } | undefined;
    if (probe && !probe.ok && probe.error) {
      issues.push({
        level: "error",
        message: `KakaoWork account "${account.accountId}" probe failed: ${probe.error}`,
        accountId: account.accountId,
      });
    }
  }

  return issues;
}
