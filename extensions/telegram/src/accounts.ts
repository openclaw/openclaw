import util from "node:util";
import { createAccountActionGate } from "../../../src/channels/plugins/account-action-gate.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { TelegramAccountConfig, TelegramActionConfig } from "../../../src/config/types.js";
import { isTruthyEnvValue } from "../../../src/infra/env.js";
import { createSubsystemLogger } from "../../../src/logging/subsystem.js";
import {
  listConfiguredAccountIds as listConfiguredAccountIdsFromSection,
  resolveAccountWithDefaultFallback,
} from "../../../src/plugin-sdk/account-resolution.js";
import { resolveAccountEntry } from "../../../src/routing/account-lookup.js";
import {
  listBoundAccountIds,
  resolveDefaultAgentBoundAccountId,
} from "../../../src/routing/bindings.js";
import { formatSetExplicitDefaultInstruction } from "../../../src/routing/default-account-warnings.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "../../../src/routing/session-key.js";
import { resolveTelegramToken } from "./token.js";

const log = createSubsystemLogger("telegram/accounts");

function formatDebugArg(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  return util.inspect(value, { colors: false, depth: null, compact: true, breakLength: Infinity });
}

const debugAccounts = (...args: unknown[]) => {
  if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_TELEGRAM_ACCOUNTS)) {
    const parts = args.map((arg) => formatDebugArg(arg));
    log.warn(parts.join(" ").trim());
  }
};

export type ResolvedTelegramAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  baseUrl?: string;
  token: string;
  tokenSource: "env" | "tokenFile" | "config" | "none";
  config: TelegramAccountConfig;
};

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  return listConfiguredAccountIdsFromSection({
    accounts: cfg.channels?.telegram?.accounts,
    normalizeAccountId,
  });
}

export function listTelegramAccountIds(cfg: OpenClawConfig): string[] {
  const ids = Array.from(
    new Set([...listConfiguredAccountIds(cfg), ...listBoundAccountIds(cfg, "telegram")]),
  );
  debugAccounts("listTelegramAccountIds", ids);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

let emittedMissingDefaultWarn = false;

/** @internal Reset the once-per-process warning flag. Exported for tests only. */
export function resetMissingDefaultWarnFlag(): void {
  emittedMissingDefaultWarn = false;
}

export function resolveDefaultTelegramAccountId(cfg: OpenClawConfig): string {
  const boundDefault = resolveDefaultAgentBoundAccountId(cfg, "telegram");
  if (boundDefault) {
    return boundDefault;
  }
  const preferred = normalizeOptionalAccountId(cfg.channels?.telegram?.defaultAccount);
  if (
    preferred &&
    listTelegramAccountIds(cfg).some((accountId) => normalizeAccountId(accountId) === preferred)
  ) {
    return preferred;
  }
  const ids = listTelegramAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  if (ids.length > 1 && !emittedMissingDefaultWarn) {
    emittedMissingDefaultWarn = true;
    log.warn(
      `channels.telegram: accounts.default is missing; falling back to "${ids[0]}". ` +
        `${formatSetExplicitDefaultInstruction("telegram")} to avoid routing surprises in multi-account setups.`,
    );
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveTelegramAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelegramAccountConfig | undefined {
  const normalized = normalizeAccountId(accountId);
  return resolveAccountEntry(cfg.channels?.telegram?.accounts, normalized);
}

export function mergeTelegramAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelegramAccountConfig {
  const {
    accounts: _ignored,
    defaultAccount: _ignoredDefaultAccount,
    groups: channelGroups,
    ...base
  } = (cfg.channels?.telegram ?? {}) as TelegramAccountConfig & {
    accounts?: unknown;
    defaultAccount?: unknown;
  };
  const account = resolveTelegramAccountConfig(cfg, accountId) ?? {};

  // In multi-account setups, channel-level `groups` must NOT be inherited by
  // accounts that don't have their own `groups` config.  A bot that is not a
  // member of a configured group will fail when handling group messages, and
  // this failure disrupts message delivery for *all* accounts.
  // Single-account setups keep backward compat: channel-level groups still
  // applies when the account has no override.
  // See: https://github.com/openclaw/openclaw/issues/30673
  const configuredAccountIds = Object.keys(cfg.channels?.telegram?.accounts ?? {});
  const isMultiAccount = configuredAccountIds.length > 1;
  const groups = account.groups ?? (isMultiAccount ? undefined : channelGroups);

  return { ...base, ...account, groups };
}

export function createTelegramActionGate(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): (key: keyof TelegramActionConfig, defaultValue?: boolean) => boolean {
  const accountId = normalizeAccountId(params.accountId);
  return createAccountActionGate({
    baseActions: params.cfg.channels?.telegram?.actions,
    accountActions: resolveTelegramAccountConfig(params.cfg, accountId)?.actions,
  });
}

export type TelegramPollActionGateState = {
  sendMessageEnabled: boolean;
  pollEnabled: boolean;
  enabled: boolean;
};

export function resolveTelegramPollActionGateState(
  isActionEnabled: (key: keyof TelegramActionConfig, defaultValue?: boolean) => boolean,
): TelegramPollActionGateState {
  const sendMessageEnabled = isActionEnabled("sendMessage");
  const pollEnabled = isActionEnabled("poll");
  return {
    sendMessageEnabled,
    pollEnabled,
    enabled: sendMessageEnabled && pollEnabled,
  };
}

export function resolveTelegramAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedTelegramAccount {
  const baseEnabled = params.cfg.channels?.telegram?.enabled !== false;

  const resolve = (accountId: string) => {
    const merged = mergeTelegramAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const tokenResolution = resolveTelegramToken(params.cfg, { accountId });
    debugAccounts("resolve", {
      accountId,
      enabled,
      tokenSource: tokenResolution.source,
    });
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      baseUrl: merged.apiRoot?.trim() || undefined,
      token: tokenResolution.token,
      tokenSource: tokenResolution.source,
      config: merged,
    } satisfies ResolvedTelegramAccount;
  };

  // If accountId is omitted, prefer a configured account token over failing on
  // the implicit "default" account. This keeps env-based setups working while
  // making config-only tokens work for things like heartbeats.
  return resolveAccountWithDefaultFallback({
    accountId: params.accountId,
    normalizeAccountId,
    resolvePrimary: resolve,
    hasCredential: (account) => account.tokenSource !== "none",
    resolveDefaultAccountId: () => resolveDefaultTelegramAccountId(params.cfg),
  });
}

export function listEnabledTelegramAccounts(cfg: OpenClawConfig): ResolvedTelegramAccount[] {
  return listTelegramAccountIds(cfg)
    .map((accountId) => resolveTelegramAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
