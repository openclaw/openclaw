import {
  createAccountListHelpers,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/twilio-sms";
import type { ResolvedTwilioSmsAccount, TwilioSmsAccountConfig } from "./types.js";

const {
  listAccountIds: listTwilioSmsAccountIds,
  resolveDefaultAccountId: resolveDefaultTwilioSmsAccountId,
} = createAccountListHelpers("twilio-sms");
export { listTwilioSmsAccountIds, resolveDefaultTwilioSmsAccountId };

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TwilioSmsAccountConfig | undefined {
  const channel = cfg.channels?.["twilio-sms"] as
    | (TwilioSmsAccountConfig & { accounts?: Record<string, TwilioSmsAccountConfig> })
    | undefined;
  return channel?.accounts?.[accountId];
}

function mergeTwilioSmsAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TwilioSmsAccountConfig {
  const base = (cfg.channels?.["twilio-sms"] ?? {}) as TwilioSmsAccountConfig & {
    accounts?: unknown;
    defaultAccount?: unknown;
  };
  const { accounts: _ignored, defaultAccount: _ignoredDefault, ...rest } = base;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...rest, ...account };
}

export function resolveTwilioSmsAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedTwilioSmsAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = (params.cfg.channels?.["twilio-sms"] as TwilioSmsAccountConfig | undefined)
    ?.enabled;
  const merged = mergeTwilioSmsAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const configured = Boolean(merged.accountSid && merged.authToken && merged.phoneNumber);
  return {
    accountId,
    enabled: baseEnabled !== false && accountEnabled,
    name: merged.name?.trim() || undefined,
    config: merged,
    configured,
  };
}

export function listEnabledTwilioSmsAccounts(cfg: OpenClawConfig): ResolvedTwilioSmsAccount[] {
  return listTwilioSmsAccountIds(cfg)
    .map((accountId) => resolveTwilioSmsAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
