import type {
  ChannelAccountSnapshot,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import {
  appendMatchMetadata,
  isRecord,
  readAccountStatusSnapshot,
  resolveEnabledConfiguredAccountId,
  type AccountStatusSnapshot,
} from "openclaw/plugin-sdk/status-helpers";
import { asFiniteNumber, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const TELEGRAM_CONNECT_GRACE_MS = 120_000;
const TELEGRAM_POLLING_STALE_TRANSPORT_MS = 30 * 60_000;

const TELEGRAM_ACCOUNT_STATUS_FIELDS = [
  "mode",
  "lastStartAt",
  "lastTransportActivityAt",
  "lastError",
  "allowUnmentionedGroups",
  "audit",
] as const;

type TelegramAccountStatus = AccountStatusSnapshot<(typeof TELEGRAM_ACCOUNT_STATUS_FIELDS)[number]>;

type TelegramGroupMembershipAuditSummary = {
  unresolvedGroups?: number;
  hasWildcardUnmentionedGroups?: boolean;
  groups?: Array<{
    chatId: string;
    ok?: boolean;
    status?: string | null;
    error?: string | null;
    matchKey?: string;
    matchSource?: string;
  }>;
};

function appendTelegramRuntimeError(message: string, lastError: unknown): string {
  const error = normalizeOptionalString(lastError);
  return error ? `${message}: ${error}` : message;
}

function isTelegramPollingBacklogStallError(lastError: unknown): boolean {
  const error = normalizeOptionalString(lastError);
  return Boolean(
    error?.includes("isolated polling spool backlog stalled") ||
    error?.includes("isolated polling spool handler timed out"),
  );
}

function collectTelegramRuntimeIssues(params: {
  account: TelegramAccountStatus;
  accountId: string;
  issues: ChannelStatusIssue[];
  now: number;
}) {
  const { account, accountId, issues, now } = params;
  const mode = normalizeOptionalString(account.mode);
  if (account.running !== true || (mode !== "polling" && mode !== "webhook")) {
    return;
  }

  const lastStartAt = asFiniteNumber(account.lastStartAt) ?? null;
  const fix =
    mode === "polling"
      ? `Run: ${formatCliCommand("openclaw channels status --probe")} (or restart the gateway). Check the bot token, proxy/network settings, and logs if it persists.`
      : `Run: ${formatCliCommand("openclaw channels status --probe")} (or restart the gateway). Check the webhook URL, secret, TLS/proxy reachability, and Telegram setWebhook logs if it persists.`;

  if (account.connected === false) {
    const withinStartupGrace = lastStartAt != null && now - lastStartAt < TELEGRAM_CONNECT_GRACE_MS;
    if (!withinStartupGrace) {
      const message =
        mode === "webhook"
          ? "Telegram webhook listener is running but setWebhook has not completed since startup"
          : isTelegramPollingBacklogStallError(account.lastError)
            ? "Telegram isolated polling spool backlog is stalled while Bot API polling is still succeeding"
            : "Telegram polling is running but has not completed a successful getUpdates call since startup";
      issues.push({
        channel: "telegram",
        accountId,
        kind: "runtime",
        message: appendTelegramRuntimeError(message, account.lastError),
        fix,
      });
    }
    return;
  }

  const lastTransportActivityAt = asFiniteNumber(account.lastTransportActivityAt) ?? null;
  if (mode === "polling" && account.connected === true && lastTransportActivityAt != null) {
    if (lastStartAt != null && lastTransportActivityAt < lastStartAt) {
      const lifecycleAgeMs = Math.max(0, now - lastStartAt);
      if (lifecycleAgeMs <= TELEGRAM_POLLING_STALE_TRANSPORT_MS) {
        return;
      }
    }
    const ageMs = now - lastTransportActivityAt;
    if (ageMs > TELEGRAM_POLLING_STALE_TRANSPORT_MS) {
      issues.push({
        channel: "telegram",
        accountId,
        kind: "runtime",
        message: appendTelegramRuntimeError(
          `Telegram polling transport is stale (last successful getUpdates ${Math.max(0, Math.floor(ageMs / 60_000))}m ago)`,
          account.lastError,
        ),
        fix,
      });
    }
  }
}

function readTelegramGroupMembershipAuditSummary(
  value: unknown,
): TelegramGroupMembershipAuditSummary {
  if (!isRecord(value)) {
    return {};
  }
  const unresolvedGroups = asFiniteNumber(value.unresolvedGroups);
  const hasWildcardUnmentionedGroups =
    typeof value.hasWildcardUnmentionedGroups === "boolean"
      ? value.hasWildcardUnmentionedGroups
      : undefined;
  const groupsRaw = value.groups;
  const groups = Array.isArray(groupsRaw)
    ? groupsRaw
        .map((entry) => {
          if (!isRecord(entry)) {
            return null;
          }
          const chatId = normalizeOptionalString(entry.chatId);
          if (!chatId) {
            return null;
          }
          const ok = typeof entry.ok === "boolean" ? entry.ok : undefined;
          const status = normalizeOptionalString(entry.status) ?? null;
          const error = normalizeOptionalString(entry.error) ?? null;
          const matchKey = normalizeOptionalString(entry.matchKey);
          const matchSource = normalizeOptionalString(entry.matchSource);
          return { chatId, ok, status, error, matchKey, matchSource };
        })
        .filter((entry) => entry !== null)
    : undefined;
  return { unresolvedGroups, hasWildcardUnmentionedGroups, groups };
}

export function collectTelegramStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const entry of accounts) {
    const account = readAccountStatusSnapshot(entry, TELEGRAM_ACCOUNT_STATUS_FIELDS);
    if (!account) {
      continue;
    }
    const accountId = resolveEnabledConfiguredAccountId(account);
    if (!accountId) {
      continue;
    }
    const now = Date.now();

    collectTelegramRuntimeIssues({
      account,
      accountId,
      issues,
      now,
    });

    if (account.allowUnmentionedGroups === true) {
      issues.push({
        channel: "telegram",
        accountId,
        kind: "config",
        message:
          "Config allows unmentioned group messages (requireMention=false). Telegram Bot API privacy mode will block most group messages unless disabled.",
        fix: "In BotFather run /setprivacy → Disable for this bot (then restart the gateway).",
      });
    }

    const audit = readTelegramGroupMembershipAuditSummary(account.audit);
    if (audit.hasWildcardUnmentionedGroups === true) {
      issues.push({
        channel: "telegram",
        accountId,
        kind: "config",
        message:
          'Telegram groups config uses "*" with requireMention=false; membership probing is not possible without explicit group IDs.',
        fix: "Add explicit numeric group ids under channels.telegram.groups (or per-account groups) to enable probing.",
      });
    }
    if (audit.unresolvedGroups && audit.unresolvedGroups > 0) {
      issues.push({
        channel: "telegram",
        accountId,
        kind: "config",
        message: `Some configured Telegram groups are not numeric IDs (unresolvedGroups=${audit.unresolvedGroups}). Membership probe can only check numeric group IDs.`,
        fix: "Use numeric chat IDs (e.g. -100...) as keys in channels.telegram.groups for requireMention=false groups.",
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
          matchSource: group.matchSource,
        }),
        fix: "Invite the bot to the group, then DM the bot once (/start) and restart the gateway.",
      });
    }
  }
  return issues;
}
