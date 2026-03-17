import util from "node:util";
import { createAccountActionGate } from "../../../src/channels/plugins/account-action-gate.js";
import { isTruthyEnvValue } from "../../../src/infra/env.js";
import { createSubsystemLogger } from "../../../src/logging/subsystem.js";
import {
  listConfiguredAccountIds as listConfiguredAccountIdsFromSection,
  resolveAccountWithDefaultFallback
} from "../../../src/plugin-sdk/account-resolution.js";
import { resolveAccountEntry } from "../../../src/routing/account-lookup.js";
import {
  listBoundAccountIds,
  resolveDefaultAgentBoundAccountId
} from "../../../src/routing/bindings.js";
import { formatSetExplicitDefaultInstruction } from "../../../src/routing/default-account-warnings.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId
} from "../../../src/routing/session-key.js";
import { resolveTelegramToken } from "./token.js";
const log = createSubsystemLogger("telegram/accounts");
function formatDebugArg(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  return util.inspect(value, { colors: false, depth: null, compact: true, breakLength: Infinity });
}
const debugAccounts = (...args) => {
  if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_TELEGRAM_ACCOUNTS)) {
    const parts = args.map((arg) => formatDebugArg(arg));
    log.warn(parts.join(" ").trim());
  }
};
function listConfiguredAccountIds(cfg) {
  return listConfiguredAccountIdsFromSection({
    accounts: cfg.channels?.telegram?.accounts,
    normalizeAccountId
  });
}
function listTelegramAccountIds(cfg) {
  const ids = Array.from(
    /* @__PURE__ */ new Set([...listConfiguredAccountIds(cfg), ...listBoundAccountIds(cfg, "telegram")])
  );
  debugAccounts("listTelegramAccountIds", ids);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}
let emittedMissingDefaultWarn = false;
function resetMissingDefaultWarnFlag() {
  emittedMissingDefaultWarn = false;
}
function resolveDefaultTelegramAccountId(cfg) {
  const boundDefault = resolveDefaultAgentBoundAccountId(cfg, "telegram");
  if (boundDefault) {
    return boundDefault;
  }
  const preferred = normalizeOptionalAccountId(cfg.channels?.telegram?.defaultAccount);
  if (preferred && listTelegramAccountIds(cfg).some((accountId) => normalizeAccountId(accountId) === preferred)) {
    return preferred;
  }
  const ids = listTelegramAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  if (ids.length > 1 && !emittedMissingDefaultWarn) {
    emittedMissingDefaultWarn = true;
    log.warn(
      `channels.telegram: accounts.default is missing; falling back to "${ids[0]}". ${formatSetExplicitDefaultInstruction("telegram")} to avoid routing surprises in multi-account setups.`
    );
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}
function resolveTelegramAccountConfig(cfg, accountId) {
  const normalized = normalizeAccountId(accountId);
  return resolveAccountEntry(cfg.channels?.telegram?.accounts, normalized);
}
function mergeTelegramAccountConfig(cfg, accountId) {
  const {
    accounts: _ignored,
    defaultAccount: _ignoredDefaultAccount,
    groups: channelGroups,
    ...base
  } = cfg.channels?.telegram ?? {};
  const account = resolveTelegramAccountConfig(cfg, accountId) ?? {};
  const configuredAccountIds = Object.keys(cfg.channels?.telegram?.accounts ?? {});
  const isMultiAccount = configuredAccountIds.length > 1;
  const groups = account.groups ?? (isMultiAccount ? void 0 : channelGroups);
  return { ...base, ...account, groups };
}
function createTelegramActionGate(params) {
  const accountId = normalizeAccountId(params.accountId);
  return createAccountActionGate({
    baseActions: params.cfg.channels?.telegram?.actions,
    accountActions: resolveTelegramAccountConfig(params.cfg, accountId)?.actions
  });
}
function resolveTelegramPollActionGateState(isActionEnabled) {
  const sendMessageEnabled = isActionEnabled("sendMessage");
  const pollEnabled = isActionEnabled("poll");
  return {
    sendMessageEnabled,
    pollEnabled,
    enabled: sendMessageEnabled && pollEnabled
  };
}
function resolveTelegramAccount(params) {
  const baseEnabled = params.cfg.channels?.telegram?.enabled !== false;
  const resolve = (accountId) => {
    const merged = mergeTelegramAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const tokenResolution = resolveTelegramToken(params.cfg, { accountId });
    debugAccounts("resolve", {
      accountId,
      enabled,
      tokenSource: tokenResolution.source
    });
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || void 0,
      token: tokenResolution.token,
      tokenSource: tokenResolution.source,
      config: merged
    };
  };
  return resolveAccountWithDefaultFallback({
    accountId: params.accountId,
    normalizeAccountId,
    resolvePrimary: resolve,
    hasCredential: (account) => account.tokenSource !== "none",
    resolveDefaultAccountId: () => resolveDefaultTelegramAccountId(params.cfg)
  });
}
function listEnabledTelegramAccounts(cfg) {
  return listTelegramAccountIds(cfg).map((accountId) => resolveTelegramAccount({ cfg, accountId })).filter((account) => account.enabled);
}
export {
  createTelegramActionGate,
  listEnabledTelegramAccounts,
  listTelegramAccountIds,
  mergeTelegramAccountConfig,
  resetMissingDefaultWarnFlag,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
  resolveTelegramAccountConfig,
  resolveTelegramPollActionGateState
};
