import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import {
  DEFAULT_ACCOUNT_ID,
  hasConfiguredAccountValue,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import { resolveDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  normalizeOptionalString,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SynologyChatChannelConfig, ResolvedSynologyChatAccount } from "./types.js";

function getChannelConfig(cfg: OpenClawConfig): SynologyChatChannelConfig | undefined {
  return cfg?.channels?.["synology-chat"] as SynologyChatChannelConfig | undefined;
}

const { listAccountIds, resolveAccountConfig: resolveMergedSynologyChatAccountConfig } =
  createAccountListHelpers<Record<string, unknown> & SynologyChatChannelConfig>("synology-chat", {
    fallbackAccountIdWhenEmpty: false,
    hasImplicitDefaultAccount: (cfg) => {
      const channel = getChannelConfig(cfg);
      return Boolean(
        channel &&
        (hasConfiguredAccountValue(channel.token) ||
          hasConfiguredAccountValue(process.env.SYNOLOGY_CHAT_TOKEN)),
      );
    },
  });

export { listAccountIds };

export function getRawAccountConfig(
  channelCfg: SynologyChatChannelConfig,
  accountId: string,
): SynologyChatChannelConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return channelCfg;
  }
  return channelCfg.accounts?.[accountId] ?? {};
}

function hasExplicitWebhookPath(rawAccount: SynologyChatChannelConfig | undefined): boolean {
  return typeof rawAccount?.webhookPath === "string" && rawAccount.webhookPath.trim().length > 0;
}

function normalizeRateLimitPerMinuteValue(raw: unknown): number | undefined {
  if (typeof raw === "string" && !/^\d+$/.test(raw.trim())) {
    return undefined;
  }
  return parseStrictNonNegativeInteger(raw);
}

export function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedSynologyChatAccount {
  const channelCfg = getChannelConfig(cfg) ?? {};
  const id = accountId || DEFAULT_ACCOUNT_ID;
  const accountOverrides = id === DEFAULT_ACCOUNT_ID ? undefined : channelCfg.accounts?.[id];
  const rawAccount = getRawAccountConfig(channelCfg, id);
  const merged = resolveMergedSynologyChatAccountConfig(cfg, id);

  // Env var fallbacks (primarily for the "default" account)
  const envToken = normalizeOptionalString(process.env.SYNOLOGY_CHAT_TOKEN) ?? "";
  const envIncomingUrl = normalizeOptionalString(process.env.SYNOLOGY_CHAT_INCOMING_URL) ?? "";
  const envNasHost = normalizeOptionalString(process.env.SYNOLOGY_NAS_HOST) ?? "localhost";
  const envAllowedUserIds = normalizeOptionalString(process.env.SYNOLOGY_ALLOWED_USER_IDS) ?? "";
  const envRateLimitValue = normalizeRateLimitPerMinuteValue(process.env.SYNOLOGY_RATE_LIMIT) ?? 30;
  const envBotName = normalizeOptionalString(process.env.OPENCLAW_BOT_NAME) ?? "OpenClaw";
  const webhookPathSource = hasExplicitWebhookPath(rawAccount)
    ? "explicit"
    : id !== DEFAULT_ACCOUNT_ID && hasExplicitWebhookPath(channelCfg)
      ? "inherited-base"
      : "default";
  const dangerouslyAllowInheritedWebhookPath =
    rawAccount.dangerouslyAllowInheritedWebhookPath ??
    channelCfg.dangerouslyAllowInheritedWebhookPath ??
    false;
  const rawAllowedUserIds = merged.allowedUserIds ?? envAllowedUserIds;

  // Merge: account override > base channel config > env var
  return {
    accountId: id,
    enabled: merged.enabled ?? true,
    token: merged.token ?? envToken,
    incomingUrl: merged.incomingUrl ?? envIncomingUrl,
    // The public callback is an exact per-route mapping. A named account with
    // its own webhookPath must not silently publish capabilities on the base route.
    webhookUrl:
      normalizeOptionalString(
        id === DEFAULT_ACCOUNT_ID ? merged.webhookUrl : rawAccount.webhookUrl,
      ) ?? "",
    nasHost: merged.nasHost ?? envNasHost,
    webhookPath: merged.webhookPath ?? "/webhook/synology",
    webhookPathSource,
    dangerouslyAllowNameMatching: resolveDangerousNameMatchingEnabled({
      providerConfig: channelCfg,
      accountConfig: accountOverrides,
    }),
    dangerouslyAllowInheritedWebhookPath,
    dmPolicy: merged.dmPolicy ?? "allowlist",
    allowedUserIds: !rawAllowedUserIds
      ? []
      : Array.isArray(rawAllowedUserIds)
        ? rawAllowedUserIds.filter(Boolean)
        : normalizeStringEntries(rawAllowedUserIds.split(",")),
    rateLimitPerMinute:
      normalizeRateLimitPerMinuteValue(merged.rateLimitPerMinute) ?? envRateLimitValue,
    botName: merged.botName ?? envBotName,
    allowInsecureSsl: merged.allowInsecureSsl ?? false,
  };
}
