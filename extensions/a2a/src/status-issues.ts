import type {
  ChannelAccountSnapshot,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
import {
  readAccountStatusSnapshot,
  resolveEnabledConfiguredAccountId,
} from "openclaw/plugin-sdk/status-helpers";
import { filterStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";

const A2A_ACCOUNT_STATUS_FIELDS = ["unresolvedPeers", "unresolvedOutboundPeers"] as const;

/**
 * Surfaces peers that config loading left unusable because a `${VAR}` credential
 * reference did not resolve. Without this the only signal is one startup log line,
 * while the remote peer just sees a bare 401 or a refused send.
 */
export function collectA2aStatusIssues(accounts: ChannelAccountSnapshot[]): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const entry of accounts) {
    const account = readAccountStatusSnapshot(entry, A2A_ACCOUNT_STATUS_FIELDS);
    if (!account) {
      continue;
    }
    // A fully withheld channel reports configured=false, so only enabled accounts are skipped here.
    const accountId = resolveEnabledConfiguredAccountId(account) ?? account.accountId;
    if (account.enabled === false || typeof accountId !== "string" || !accountId) {
      continue;
    }
    const inbound = filterStringEntries(account.unresolvedPeers).filter(Boolean);
    if (inbound.length > 0) {
      issues.push({
        channel: "a2a",
        accountId,
        kind: "config",
        message: `A2A peer${inbound.length === 1 ? "" : "s"} ${inbound.join(", ")} cannot authenticate: the inbound token reference did not resolve, so requests from ${inbound.length === 1 ? "it are" : "them are"} rejected with 401.`,
        fix: `Set the environment variable referenced by channels.a2a.peers.<name>.token for ${inbound.join(", ")}, then reload or restart the gateway.`,
      });
    }
    const outbound = filterStringEntries(account.unresolvedOutboundPeers).filter(Boolean);
    if (outbound.length > 0) {
      issues.push({
        channel: "a2a",
        accountId,
        kind: "config",
        message: `Sends to A2A peer${outbound.length === 1 ? "" : "s"} ${outbound.join(", ")} are refused: the outbound token reference did not resolve.`,
        fix: `Set the environment variable referenced by channels.a2a.peers.<name>.outboundToken for ${outbound.join(", ")}, then reload or restart the gateway.`,
      });
    }
  }
  return issues;
}
