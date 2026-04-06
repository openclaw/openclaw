import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  buildTokenChannelStatusSummary,
  projectCredentialSnapshotFields,
  resolveConfiguredFromCredentialStatuses,
} from "openclaw/plugin-sdk/channel-status";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import type { ResolvedTelegramAccount } from "./accounts.js";
import type { TelegramProbe } from "./probe.js";
import { getTelegramRuntime } from "./runtime.js";
import { findTelegramTokenOwnerAccountId, formatDuplicateTelegramTokenReason } from "./shared.js";
import { collectTelegramStatusIssues } from "./status-issues.js";

let telegramAuditModulePromise: Promise<typeof import("./audit.js")> | null = null;
let telegramProbeModulePromise: Promise<typeof import("./probe.js")> | null = null;

async function loadTelegramAuditModule() {
  telegramAuditModulePromise ??= import("./audit.js");
  return await telegramAuditModulePromise;
}

async function loadTelegramProbeModule() {
  telegramProbeModulePromise ??= import("./probe.js");
  return await telegramProbeModulePromise;
}

function getOptionalTelegramRuntime() {
  try {
    return getTelegramRuntime();
  } catch {
    return null;
  }
}

async function resolveTelegramProbe() {
  return (
    getOptionalTelegramRuntime()?.channel?.telegram?.probeTelegram ??
    (await loadTelegramProbeModule()).probeTelegram
  );
}

async function resolveTelegramAuditCollector() {
  return (
    getOptionalTelegramRuntime()?.channel?.telegram?.collectTelegramUnmentionedGroupIds ??
    (await loadTelegramAuditModule()).collectTelegramUnmentionedGroupIds
  );
}

async function resolveTelegramAuditMembership() {
  return (
    getOptionalTelegramRuntime()?.channel?.telegram?.auditTelegramGroupMembership ??
    (await loadTelegramAuditModule()).auditTelegramGroupMembership
  );
}

export const telegramStatus = createComputedAccountStatusAdapter<
  ResolvedTelegramAccount,
  TelegramProbe,
  unknown
>({
  defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
  collectStatusIssues: collectTelegramStatusIssues,
  buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
  probeAccount: async ({ account, timeoutMs }) =>
    (await resolveTelegramProbe())(account.token, timeoutMs, {
      accountId: account.accountId,
      proxyUrl: account.config.proxy,
      network: account.config.network,
      apiRoot: account.config.apiRoot,
    }),
  formatCapabilitiesProbe: ({ probe }) => {
    const lines = [];
    if (probe?.bot?.username) {
      const botId = probe.bot.id ? ` (${probe.bot.id})` : "";
      lines.push({ text: `Bot: @${probe.bot.username}${botId}` });
    }
    const flags: string[] = [];
    if (typeof probe?.bot?.canJoinGroups === "boolean") {
      flags.push(`joinGroups=${probe.bot.canJoinGroups}`);
    }
    if (typeof probe?.bot?.canReadAllGroupMessages === "boolean") {
      flags.push(`readAllGroupMessages=${probe.bot.canReadAllGroupMessages}`);
    }
    if (typeof probe?.bot?.supportsInlineQueries === "boolean") {
      flags.push(`inlineQueries=${probe.bot.supportsInlineQueries}`);
    }
    if (flags.length > 0) {
      lines.push({ text: `Flags: ${flags.join(" ")}` });
    }
    if (probe?.webhook?.url !== undefined) {
      lines.push({ text: `Webhook: ${probe.webhook.url || "none"}` });
    }
    return lines;
  },
  auditAccount: async ({ account, timeoutMs, probe, cfg }) => {
    const groups =
      cfg.channels?.telegram?.accounts?.[account.accountId]?.groups ??
      cfg.channels?.telegram?.groups;
    const { groupIds, unresolvedGroups, hasWildcardUnmentionedGroups } = (
      await resolveTelegramAuditCollector()
    )(groups);
    if (!groupIds.length && unresolvedGroups === 0 && !hasWildcardUnmentionedGroups) {
      return undefined;
    }
    const botId = probe?.ok && probe.bot?.id != null ? probe.bot.id : null;
    if (!botId) {
      return {
        ok: unresolvedGroups === 0 && !hasWildcardUnmentionedGroups,
        checkedGroups: 0,
        unresolvedGroups,
        hasWildcardUnmentionedGroups,
        groups: [],
        elapsedMs: 0,
      };
    }
    const auditMembership = await resolveTelegramAuditMembership();
    const audit = await auditMembership({
      token: account.token,
      botId,
      groupIds,
      proxyUrl: account.config.proxy,
      network: account.config.network,
      apiRoot: account.config.apiRoot,
      timeoutMs,
    });
    return { ...audit, unresolvedGroups, hasWildcardUnmentionedGroups };
  },
  resolveAccountSnapshot: ({ account, cfg, runtime, audit }) => {
    const configuredFromStatus = resolveConfiguredFromCredentialStatuses(account);
    const ownerAccountId = findTelegramTokenOwnerAccountId({
      cfg,
      accountId: account.accountId,
    });
    const duplicateTokenReason = ownerAccountId
      ? formatDuplicateTelegramTokenReason({
          accountId: account.accountId,
          ownerAccountId,
        })
      : null;
    const configured = (configuredFromStatus ?? Boolean(account.token?.trim())) && !ownerAccountId;
    const groups =
      cfg.channels?.telegram?.accounts?.[account.accountId]?.groups ??
      cfg.channels?.telegram?.groups;
    const allowUnmentionedGroups =
      groups?.["*"]?.requireMention === false ||
      Object.entries(groups ?? {}).some(
        ([key, value]) => key !== "*" && value?.requireMention === false,
      );
    return {
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured,
      extra: {
        ...projectCredentialSnapshotFields(account),
        lastError: runtime?.lastError ?? duplicateTokenReason,
        mode: runtime?.mode ?? (account.config.webhookUrl ? "webhook" : "polling"),
        audit,
        allowUnmentionedGroups,
      },
    };
  },
});
