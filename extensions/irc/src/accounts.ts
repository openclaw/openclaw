import { readFileSync } from "node:fs";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { CoreConfig, IrcAccountConfig, IrcNickServConfig } from "./types.js";

const TRUTHY_ENV = new Set(["true", "1", "yes", "on"]);

export type ResolvedIrcAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  username: string;
  realname: string;
  password: string;
  passwordSource: "env" | "passwordFile" | "config" | "none";
  config: IrcAccountConfig;
};

function parseTruthy(value?: string): boolean {
  if (!value) {
    return false;
  }
  return TRUTHY_ENV.has(value.trim().toLowerCase());
}

function parseIntEnv(value?: string): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return undefined;
  }
  return parsed;
}

function parseListEnv(value?: string): string[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = value
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

function listConfiguredAccountIds(cfg: CoreConfig): string[] {
  const accounts = cfg.channels?.irc?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  const ids = new Set<string>();
  for (const key of Object.keys(accounts)) {
    if (key.trim()) {
      ids.add(normalizeAccountId(key));
    }
  }
  return [...ids];
}

function resolveAccountConfig(cfg: CoreConfig, accountId: string): IrcAccountConfig | undefined {
  const accounts = cfg.channels?.irc?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const direct = accounts[accountId] as IrcAccountConfig | undefined;
  if (direct) {
    return direct;
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? (accounts[matchKey] as IrcAccountConfig | undefined) : undefined;
}

function mergeIrcAccountConfig(cfg: CoreConfig, accountId: string): IrcAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.irc ?? {}) as IrcAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  const merged: IrcAccountConfig = { ...base, ...account };
  if (base.nickserv || account.nickserv) {
    merged.nickserv = {
      ...base.nickserv,
      ...account.nickserv,
    };
  }
  return merged;
}

function resolvePassword(accountId: string, merged: IrcAccountConfig) {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const envPassword = process.env.IRC_PASSWORD?.trim();
    if (envPassword) {
      return { password: envPassword, source: "env" as const };
    }
  }

  if (merged.passwordFile?.trim()) {
    try {
      const filePassword = readFileSync(merged.passwordFile.trim(), "utf-8").trim();
      if (filePassword) {
        return { password: filePassword, source: "passwordFile" as const };
      }
    } catch {
      // Ignore unreadable files here; status will still surface missing configuration.
    }
  }

  const configPassword = merged.password?.trim();
  if (configPassword) {
    return { password: configPassword, source: "config" as const };
  }

  return { password: "", source: "none" as const };
}

function resolveNickServConfig(accountId: string, nickserv?: IrcNickServConfig): IrcNickServConfig {
  const base = nickserv ?? {};
  const envPassword =
    accountId === DEFAULT_ACCOUNT_ID ? process.env.IRC_NICKSERV_PASSWORD?.trim() : undefined;
  const envRegisterEmail =
    accountId === DEFAULT_ACCOUNT_ID ? process.env.IRC_NICKSERV_REGISTER_EMAIL?.trim() : undefined;

  const passwordFile = base.passwordFile?.trim();
  let resolvedPassword = base.password?.trim() || envPassword || "";
  if (!resolvedPassword && passwordFile) {
    try {
      resolvedPassword = readFileSync(passwordFile, "utf-8").trim();
    } catch {
      // Ignore unreadable files; monitor/probe status will surface failures.
    }
  }

  const merged: IrcNickServConfig = {
    ...base,
    service: base.service?.trim() || undefined,
    passwordFile: passwordFile || undefined,
    password: resolvedPassword || undefined,
    registerEmail: base.registerEmail?.trim() || envRegisterEmail || undefined,
  };
  return merged;
}

export function listIrcAccountIds(cfg: CoreConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultIrcAccountId(cfg: CoreConfig): string {
  const ids = listIrcAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveIrcAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedIrcAccount {
  const hasExplicitAccountId = Boolean(params.accountId?.trim());
  const baseEnabled = params.cfg.channels?.irc?.enabled !== false;

  const resolve = (accountId: string) => {
    const merged = mergeIrcAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;

    const tls =
      typeof merged.tls === "boolean"
        ? merged.tls
        : accountId === DEFAULT_ACCOUNT_ID && process.env.IRC_TLS
          ? parseTruthy(process.env.IRC_TLS)
          : true;

    const envPort =
      accountId === DEFAULT_ACCOUNT_ID ? parseIntEnv(process.env.IRC_PORT) : undefined;
    const port = merged.port ?? envPort ?? (tls ? 6697 : 6667);
    const envChannels =
      accountId === DEFAULT_ACCOUNT_ID ? parseListEnv(process.env.IRC_CHANNELS) : undefined;

    const host = (
      merged.host?.trim() ||
      (accountId === DEFAULT_ACCOUNT_ID ? process.env.IRC_HOST?.trim() : "") ||
      ""
    ).trim();
    const nick = (
      merged.nick?.trim() ||
      (accountId === DEFAULT_ACCOUNT_ID ? process.env.IRC_NICK?.trim() : "") ||
      ""
    ).trim();
    const username = (
      merged.username?.trim() ||
      (accountId === DEFAULT_ACCOUNT_ID ? process.env.IRC_USERNAME?.trim() : "") ||
      nick ||
      "openclaw"
    ).trim();
    const realname = (
      merged.realname?.trim() ||
      (accountId === DEFAULT_ACCOUNT_ID ? process.env.IRC_REALNAME?.trim() : "") ||
      "OpenClaw"
    ).trim();

    const passwordResolution = resolvePassword(accountId, merged);
    const nickserv = resolveNickServConfig(accountId, merged.nickserv);

    const config: IrcAccountConfig = {
      ...merged,
      channels: merged.channels ?? envChannels,
      tls,
      port,
      host,
      nick,
      username,
      realname,
      nickserv,
    };

    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      configured: Boolean(host && nick),
      host,
      port,
      tls,
      nick,
      username,
      realname,
      password: passwordResolution.password,
      passwordSource: passwordResolution.source,
      config,
    } satisfies ResolvedIrcAccount;
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

export function listEnabledIrcAccounts(cfg: CoreConfig): ResolvedIrcAccount[] {
  return listIrcAccountIds(cfg)
    .map((accountId) => resolveIrcAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
