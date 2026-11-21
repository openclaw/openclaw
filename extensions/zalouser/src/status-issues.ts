import type {
  ChannelAccountSnapshot,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
import {
  standardDmPolicyOpenIssue,
  standardNotConfiguredIssue,
} from "openclaw/plugin-sdk/status-helpers";

export function collectZalouserStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const account of accounts) {
    const { accountId } = account;
    if (account.enabled === false) {
      continue;
    }

    if (account.configured !== true || account.linked === false) {
      issues.push(
        standardNotConfiguredIssue({
          channel: "zalouser",
          accountId,
          message: "Not authenticated (no saved Zalo session).",
          fix: "Run: openclaw channels login --channel zalouser",
        }),
      );
      continue;
    }

    if (account.dmPolicy === "open") {
      issues.push(
        standardDmPolicyOpenIssue({
          channel: "zalouser",
          accountId,
          channelLabel: "Zalo Personal",
          configPath: "channels.zalouser",
        }),
      );
    }
  }
  return issues;
}
