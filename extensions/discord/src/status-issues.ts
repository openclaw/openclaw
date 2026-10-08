import type {
  ChannelAccountSnapshot,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
import {
  appendMatchMetadata,
  isRecord,
  readAccountStatusSnapshot,
  resolveEnabledConfiguredAccountId,
} from "openclaw/plugin-sdk/status-helpers";
import {
  asFiniteNumber,
  normalizeOptionalString,
  normalizeOptionalTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";

function isDiscordMessageContentIntentDisabled(value: unknown): boolean {
  return isRecord(value) && isRecord(value.intents) && value.intents.messageContent === "disabled";
}

function readDiscordPermissionsAuditSummary(value: unknown) {
  if (!isRecord(value)) {
    return {};
  }
  const unresolvedChannels = asFiniteNumber(value.unresolvedChannels);
  const channelsRaw = value.channels;
  const channels = Array.isArray(channelsRaw)
    ? channelsRaw
        .map((entry) => {
          if (!isRecord(entry)) {
            return null;
          }
          const channelId = normalizeOptionalString(entry.channelId);
          if (!channelId) {
            return null;
          }
          return {
            channelId,
            ok: typeof entry.ok === "boolean" ? entry.ok : undefined,
            missing: normalizeOptionalTrimmedStringList(entry.missing),
            error: normalizeOptionalString(entry.error) ?? null,
            matchKey: normalizeOptionalString(entry.matchKey),
            matchSource: normalizeOptionalString(entry.matchSource),
          };
        })
        .filter((entry) => entry !== null)
    : undefined;
  return { unresolvedChannels, channels };
}

export function collectDiscordStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const entry of accounts) {
    const account = readAccountStatusSnapshot(entry, [
      "application",
      "audit",
      "groupPolicy",
      "guildsConfigured",
    ]);
    if (!account) {
      continue;
    }
    const accountId = resolveEnabledConfiguredAccountId(account);
    if (!accountId) {
      continue;
    }
    const scope = { channel: "discord", accountId } as const;

    if (account.groupPolicy === "allowlist" && account.guildsConfigured === 0) {
      const guildGuidance =
        accountId === "default"
          ? "Add your server under channels.discord.guilds. If channels.discord.accounts.default.guilds is set, add it there instead."
          : `Add your server under channels.discord.accounts.${accountId}.guilds.`;
      issues.push({
        ...scope,
        kind: "config",
        message:
          'Discord guild messages are blocked: effective groupPolicy is "allowlist", but no guilds are configured.',
        fix: `${guildGuidance} Refresh channel status after the configuration reload applies.`,
      });
    }

    if (isDiscordMessageContentIntentDisabled(account.application)) {
      issues.push({
        ...scope,
        kind: "intent",
        message: "Message Content Intent is disabled. Bot may not see normal channel messages.",
        fix: "Enable Message Content Intent in Discord Dev Portal → Bot → Privileged Gateway Intents, or require mention-only operation.",
      });
    }

    const audit = readDiscordPermissionsAuditSummary(account.audit);
    if (audit.unresolvedChannels && audit.unresolvedChannels > 0) {
      issues.push({
        ...scope,
        kind: "config",
        message: `Some configured guild channels are not numeric IDs (unresolvedChannels=${audit.unresolvedChannels}). Permission audit can only check numeric channel IDs.`,
        fix: "Use numeric channel IDs as keys in channels.discord.guilds.*.channels (then rerun channels status --probe).",
      });
    }
    for (const channel of audit.channels ?? []) {
      if (channel.ok === true) {
        continue;
      }
      const missing = channel.missing?.length ? ` missing ${channel.missing.join(", ")}` : "";
      const error = channel.error ? `: ${channel.error}` : "";
      const baseMessage = `Channel ${channel.channelId} permission check failed.${missing}${error}`;
      issues.push({
        ...scope,
        kind: "permissions",
        message: appendMatchMetadata(baseMessage, {
          matchKey: channel.matchKey,
          matchSource: channel.matchSource,
        }),
        fix: "Ensure the bot role can view + send in this channel (and that channel overrides don't deny it).",
      });
    }
  }
  return issues;
}
