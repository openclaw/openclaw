import { createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createAllowlistProviderRouteAllowlistWarningCollector,
  createConditionalWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import { mergeTelegramAccountConfig } from "./account-config.js";
import { resolveDefaultTelegramAccountId } from "./account-selection.js";
import type { ResolvedTelegramAccount } from "./accounts.js";
import { resolveTelegramSecurityDmRoute } from "./dm-session-key.js";
import {
  resolveTelegramDirectToolPolicy,
  resolveTelegramScopedGroupConfig,
} from "./group-config-helpers.js";
import { collectTelegramSecurityAuditFindings } from "./security-audit.js";

const resolveTelegramDmPolicy = createScopedDmSecurityResolver<ResolvedTelegramAccount>({
  channelKey: "telegram",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) => raw.replace(/^(telegram|tg):/i, ""),
});

const collectTelegramSecurityWarnings =
  createAllowlistProviderRouteAllowlistWarningCollector<ResolvedTelegramAccount>({
    providerConfigPresent: (cfg) => cfg.channels?.telegram !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    resolveRouteAllowlistConfigured: (account) =>
      Boolean(account.config.groups) && Object.keys(account.config.groups ?? {}).length > 0,
    restrictSenders: {
      surface: "Telegram groups",
      openScope: "any member in allowed groups",
      groupPolicyPath: "channels.telegram.groupPolicy",
      groupAllowFromPath: "channels.telegram.groupAllowFrom",
    },
    noRouteAllowlist: {
      surface: "Telegram groups",
      routeAllowlistPath: "channels.telegram.groups",
      routeScope: "group",
      groupPolicyPath: "channels.telegram.groupPolicy",
      groupAllowFromPath: "channels.telegram.groupAllowFrom",
    },
  });
const collectTelegramOpenGroupFindings = createConditionalWarningCollector.findings({
  collectWarnings: collectTelegramSecurityWarnings,
  checkId: "channels.telegram.groups.open",
  severity: "warn",
  title: "Telegram security warning",
});

export const telegramSecurityAdapter = {
  resolveDirectToolPolicy(params) {
    const accountId = params.accountId ?? resolveDefaultTelegramAccountId(params.cfg);
    const account = mergeTelegramAccountConfig(params.cfg, accountId);
    const { groupConfig: directConfig } = resolveTelegramScopedGroupConfig(
      account,
      params.conversationId,
    );
    return resolveTelegramDirectToolPolicy({ ...params, directConfig });
  },
  resolveDmPolicy: resolveTelegramDmPolicy,
  dmRouting: {
    resolveDmRoute: (ctx) =>
      resolveTelegramSecurityDmRoute(resolveDefaultTelegramAccountId(ctx.cfg), ctx),
  },
  collectWarnings: collectTelegramOpenGroupFindings,
  collectAuditFindings: collectTelegramSecurityAuditFindings,
} satisfies NonNullable<ChannelPlugin<ResolvedTelegramAccount>["security"]>;
