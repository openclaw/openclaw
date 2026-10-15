import type { ChannelStatusIssue } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelAccountSnapshot } from "./types.js";

export function collectTwitchStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];

  for (const entry of accounts) {
    const accountId = entry.accountId;

    if (!accountId) {
      continue;
    }

    if (!entry.configured) {
      issues.push({
        channel: "twitch",
        accountId,
        kind: "config",
        message: "Twitch account is not properly configured",
        fix: "Add required fields: username, accessToken, and clientId to your account configuration",
      });
      continue;
    }

    if (entry.enabled === false) {
      issues.push({
        channel: "twitch",
        accountId,
        kind: "config",
        message: "Twitch account is disabled",
        fix: "Set enabled: true in your account configuration to enable this account",
      });
      continue;
    }

    if (entry.lastError) {
      issues.push({
        channel: "twitch",
        accountId,
        kind: "runtime",
        message: `Last error: ${entry.lastError}`,
        fix: "Check your token validity and network connection. Check that the bot has the required OAuth scopes.",
      });
    }

    if (!entry.running && !entry.lastStartAt && !entry.lastInboundAt && !entry.lastOutboundAt) {
      issues.push({
        channel: "twitch",
        accountId,
        kind: "runtime",
        message: "Account has never connected successfully",
        fix: "Start the Twitch gateway to begin receiving messages. Check logs for connection errors.",
      });
    }

    if (entry.running && entry.lastStartAt) {
      const uptime = Date.now() - entry.lastStartAt;
      const daysSinceStart = uptime / (1000 * 60 * 60 * 24);
      if (daysSinceStart > 7) {
        issues.push({
          channel: "twitch",
          accountId,
          kind: "runtime",
          message: `Connection has been running for ${Math.floor(daysSinceStart)} days`,
          fix: "Consider restarting the connection periodically to refresh the connection. Twitch tokens may expire after long periods.",
        });
      }
    }
  }

  return issues;
}
