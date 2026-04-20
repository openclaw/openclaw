import { createAllowlistProviderRouteAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import type { ResolvedTelegramAccount } from "./accounts.js";
import { collectTelegramSecurityAuditFindings } from "./security-audit.js";

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

export const telegramSecurityAdapter = {
  dm: {
    channelKey: "telegram",
    resolvePolicy: (account: ResolvedTelegramAccount) => account.config.dmPolicy,
    resolveAllowFrom: (account: ResolvedTelegramAccount) => account.config.allowFrom,
    policyPathSuffix: "dmPolicy",
    normalizeEntry: (raw: string) => raw.replace(/^(telegram|tg):/i, ""),
  },
  collectWarnings: collectTelegramSecurityWarnings,
  collectAuditFindings: collectTelegramSecurityAuditFindings,
};
