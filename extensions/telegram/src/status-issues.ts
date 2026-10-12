import type {
  ChannelAccountSnapshot,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import {
  appendMatchMetadata,
  isRecord,
  readAccountStatusSnapshot,
  collectIssuesForEnabledAccounts,
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
type AddTelegramStatusIssue = (
  kind: ChannelStatusIssue["kind"],
  message: string,
  fix: string,
) => void;

function appendTelegramRuntimeError(message: string, lastError: unknown): string {
  const error = normalizeOptionalString(lastError);
  return error ? `${message}: ${error}` : message;
}

function isTelegramPollingBacklogStallError(lastError: unknown): boolean {
  return /isolated polling spool (?:backlog stalled|handler timed out)/.test(
    normalizeOptionalString(lastError) ?? "",
  );
}

function collectTelegramRuntimeIssues(params: {
  account: TelegramAccountStatus;
  addIssue: AddTelegramStatusIssue;
  now: number;
}) {
  const { account, addIssue, now } = params;
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
      addIssue("runtime", appendTelegramRuntimeError(message, account.lastError), fix);
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
      addIssue(
        "runtime",
        appendTelegramRuntimeError(
          `Telegram polling transport is stale (last successful getUpdates ${Math.max(0, Math.floor(ageMs / 60_000))}m ago)`,
          account.lastError,
        ),
        fix,
      );
    }
  }
}

export function collectTelegramStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  return collectIssuesForEnabledAccounts({
    accounts,
    readAccount: (entry) => readAccountStatusSnapshot(entry, TELEGRAM_ACCOUNT_STATUS_FIELDS),
    collectIssues: ({ account, accountId, issues }) => {
      if (account.configured !== true) {
        return;
      }
      const now = Date.now();
      const addIssue: AddTelegramStatusIssue = (kind, message, fix) => {
        issues.push({ channel: "telegram", accountId, kind, message, fix });
      };

      collectTelegramRuntimeIssues({
        account,
        addIssue,
        now,
      });

      if (account.allowUnmentionedGroups === true) {
        addIssue(
          "config",
          "Config allows unmentioned group messages (requireMention=false). Telegram Bot API privacy mode will block most group messages unless disabled.",
          "In BotFather run /setprivacy → Disable for this bot (then restart the gateway).",
        );
      }

      const audit = account.audit;
      if (!isRecord(audit)) {
        return;
      }
      if (audit.hasWildcardUnmentionedGroups === true) {
        addIssue(
          "config",
          'Telegram groups config uses "*" with requireMention=false; membership checking is not possible without explicit group IDs.',
          "Add explicit numeric group ids under channels.telegram.groups (or per-account groups) to enable checking.",
        );
      }
      const unresolvedGroups = asFiniteNumber(audit.unresolvedGroups);
      if (unresolvedGroups && unresolvedGroups > 0) {
        addIssue(
          "config",
          `Some configured Telegram groups are not numeric IDs (unresolvedGroups=${unresolvedGroups}). Membership checks require numeric group IDs.`,
          "Use numeric chat IDs (e.g. -100...) as keys in channels.telegram.groups for requireMention=false groups.",
        );
      }
      for (const group of Array.isArray(audit.groups) ? audit.groups : []) {
        if (!isRecord(group)) {
          continue;
        }
        const chatId = normalizeOptionalString(group.chatId);
        if (!chatId || group.ok === true) {
          continue;
        }
        const status = normalizeOptionalString(group.status);
        const error = normalizeOptionalString(group.error);
        const baseMessage = `Group ${chatId} not reachable by bot.${status ? ` status=${status}` : ""}${error ? `: ${error}` : ""}`;
        addIssue(
          "runtime",
          appendMatchMetadata(baseMessage, {
            matchKey: normalizeOptionalString(group.matchKey),
            matchSource: normalizeOptionalString(group.matchSource),
          }),
          "Invite the bot to the group, then DM the bot once (/start) and restart the gateway.",
        );
      }
    },
  });
}
