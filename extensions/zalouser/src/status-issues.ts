import type { ChannelAccountSnapshot, ChannelStatusIssue } from "openclaw/plugin-sdk/compat";

type ZalouserAccountStatus = {
  accountId?: unknown;
  enabled?: unknown;
  configured?: unknown;
  dmPolicy?: unknown;
  lastError?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object");

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;

function readZalouserAccountStatus(value: ChannelAccountSnapshot): ZalouserAccountStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    accountId: value.accountId,
    enabled: value.enabled,
    configured: value.configured,
    dmPolicy: value.dmPolicy,
    lastError: value.lastError,
  };
}

export function collectZalouserStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const entry of accounts) {
    const account = readZalouserAccountStatus(entry);
    if (!account) {
      continue;
    }
    const accountId = asString(account.accountId) ?? "default";
    const enabled = account.enabled !== false;
    if (!enabled) {
      continue;
    }

    const configured = account.configured === true;

    if (!configured) {
      issues.push({
        channel: "zalouser",
        accountId,
        kind: "auth",
        message: "Not authenticated (no saved Zalo session).",
        fix: "Run: openclaw channels login --channel zalouser",
      });
      continue;
    }

    if (account.dmPolicy === "open") {
      issues.push({
        channel: "zalouser",
        accountId,
        kind: "config",
        message:
          'Zalo Personal dmPolicy is "open", allowing any user to message the bot without pairing.',
        fix: 'Set channels.zalouser.dmPolicy to "pairing" or "allowlist" to restrict access.',
      });
    }
  }
  return issues;
}
