import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/core";
import {
  createAccountListHelpers,
  normalizeResolvedSecretInputString,
  parseOptionalDelimitedEntries
} from "openclaw/plugin-sdk/irc";
const TRUTHY_ENV = /* @__PURE__ */ new Set(["true", "1", "yes", "on"]);
function parseTruthy(value) {
  if (!value) {
    return false;
  }
  return TRUTHY_ENV.has(value.trim().toLowerCase());
}
function parseIntEnv(value) {
  if (!value?.trim()) {
    return void 0;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return void 0;
  }
  return parsed;
}
const { listAccountIds: listIrcAccountIds, resolveDefaultAccountId: resolveDefaultIrcAccountId } = createAccountListHelpers("irc", { normalizeAccountId });
function resolveAccountConfig(cfg, accountId) {
  const accounts = cfg.channels?.irc?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return void 0;
  }
  const direct = accounts[accountId];
  if (direct) {
    return direct;
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? accounts[matchKey] : void 0;
}
function mergeIrcAccountConfig(cfg, accountId) {
  const {
    accounts: _ignored,
    defaultAccount: _ignoredDefaultAccount,
    ...base
  } = cfg.channels?.irc ?? {};
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  const merged = { ...base, ...account };
  if (base.nickserv || account.nickserv) {
    merged.nickserv = {
      ...base.nickserv,
      ...account.nickserv
    };
  }
  return merged;
}
function resolvePassword(accountId, merged) {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const envPassword = process.env.IRC_PASSWORD?.trim();
    if (envPassword) {
      return { password: envPassword, source: "env" };
    }
  }
  if (merged.passwordFile?.trim()) {
    const filePassword = tryReadSecretFileSync(merged.passwordFile, "IRC password file", {
      rejectSymlink: true
    });
    if (filePassword) {
      return { password: filePassword, source: "passwordFile" };
    }
  }
  const configPassword = normalizeResolvedSecretInputString({
    value: merged.password,
    path: `channels.irc.accounts.${accountId}.password`
  });
  if (configPassword) {
    return { password: configPassword, source: "config" };
  }
  return { password: "", source: "none" };
}
function resolveNickServConfig(accountId, nickserv) {
  const base = nickserv ?? {};
  const envPassword = accountId === DEFAULT_ACCOUNT_ID ? process.env.IRC_NICKSERV_PASSWORD?.trim() : void 0;
  const envRegisterEmail = accountId === DEFAULT_ACCOUNT_ID ? process.env.IRC_NICKSERV_REGISTER_EMAIL?.trim() : void 0;
  const passwordFile = base.passwordFile?.trim();
  let resolvedPassword = normalizeResolvedSecretInputString({
    value: base.password,
    path: `channels.irc.accounts.${accountId}.nickserv.password`
  }) || envPassword || "";
  if (!resolvedPassword && passwordFile) {
    resolvedPassword = tryReadSecretFileSync(passwordFile, "IRC NickServ password file", {
      rejectSymlink: true
    }) ?? "";
  }
  const merged = {
    ...base,
    service: base.service?.trim() || void 0,
    passwordFile: passwordFile || void 0,
    password: resolvedPassword || void 0,
    registerEmail: base.registerEmail?.trim() || envRegisterEmail || void 0
  };
  return merged;
}
function resolveIrcAccount(params) {
  const hasExplicitAccountId = Boolean(params.accountId?.trim());
  const baseEnabled = params.cfg.channels?.irc?.enabled !== false;
  const resolve = (accountId) => {
    const merged = mergeIrcAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const tls = typeof merged.tls === "boolean" ? merged.tls : accountId === DEFAULT_ACCOUNT_ID && process.env.IRC_TLS ? parseTruthy(process.env.IRC_TLS) : true;
    const envPort = accountId === DEFAULT_ACCOUNT_ID ? parseIntEnv(process.env.IRC_PORT) : void 0;
    const port = merged.port ?? envPort ?? (tls ? 6697 : 6667);
    const envChannels = accountId === DEFAULT_ACCOUNT_ID ? parseOptionalDelimitedEntries(process.env.IRC_CHANNELS) : void 0;
    const host = (merged.host?.trim() || (accountId === DEFAULT_ACCOUNT_ID ? process.env.IRC_HOST?.trim() : "") || "").trim();
    const nick = (merged.nick?.trim() || (accountId === DEFAULT_ACCOUNT_ID ? process.env.IRC_NICK?.trim() : "") || "").trim();
    const username = (merged.username?.trim() || (accountId === DEFAULT_ACCOUNT_ID ? process.env.IRC_USERNAME?.trim() : "") || nick || "openclaw").trim();
    const realname = (merged.realname?.trim() || (accountId === DEFAULT_ACCOUNT_ID ? process.env.IRC_REALNAME?.trim() : "") || "OpenClaw").trim();
    const passwordResolution = resolvePassword(accountId, merged);
    const nickserv = resolveNickServConfig(accountId, merged.nickserv);
    const config = {
      ...merged,
      channels: merged.channels ?? envChannels,
      tls,
      port,
      host,
      nick,
      username,
      realname,
      nickserv
    };
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || void 0,
      configured: Boolean(host && nick),
      host,
      port,
      tls,
      nick,
      username,
      realname,
      password: passwordResolution.password,
      passwordSource: passwordResolution.source,
      config
    };
  };
  const normalized = normalizeAccountId(params.accountId);
  const primary = resolve(normalized);
  if (hasExplicitAccountId) {
    return primary;
  }
  if (primary.configured) {
    return primary;
  }
  const fallbackId = resolveDefaultIrcAccountId(params.cfg);
  if (fallbackId === primary.accountId) {
    return primary;
  }
  const fallback = resolve(fallbackId);
  if (!fallback.configured) {
    return primary;
  }
  return fallback;
}
function listEnabledIrcAccounts(cfg) {
  return listIrcAccountIds(cfg).map((accountId) => resolveIrcAccount({ cfg, accountId })).filter((account) => account.enabled);
}
export {
  listEnabledIrcAccounts,
  listIrcAccountIds,
  resolveDefaultIrcAccountId,
  resolveIrcAccount
};
