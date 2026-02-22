import type { ChannelAccountSnapshot, ChannelStatusIssue } from "openclaw/plugin-sdk";

type TuituiAccountStatus = {
  accountId?: unknown;
  enabled?: unknown;
  configured?: unknown;
  dmPolicy?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object");

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;

function readTuituiAccountStatus(value: ChannelAccountSnapshot): TuituiAccountStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    accountId: value.accountId,
    enabled: value.enabled,
    configured: value.configured,
    dmPolicy: value.dmPolicy,
  };
}

export function collectTuituiStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const entry of accounts) {
    const account = readTuituiAccountStatus(entry);
    if (!account) continue;
    const accountId = asString(account.accountId) ?? "default";
    const enabled = account.enabled !== false;
    const configured = account.configured === true;
    if (!enabled || !configured) continue;

    if (account.dmPolicy === "open") {
      issues.push({
        channel: "tuitui",
        accountId,
        kind: "config",
        message: '推推 dmPolicy 为 "open"，任何人可向该通道发送。',
        fix: '将 channels.tuitui.dmPolicy 设为 "pairing" 或 "allowlist" 以限制访问。',
      });
    }
  }
  return issues;
}
