import { readFileSync } from "node:fs";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { CoreConfig, XmppAccountConfig, XmppTlsMode } from "./types.js";

export type ResolvedXmppAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  jid: string;
  password: string;
  passwordSource: "passwordFile" | "config" | "none";
  server: string;
  domain?: string;
  resource: string;
  port: number;
  tls: boolean;
  tlsMode: XmppTlsMode;
  allowSelfSignedTls: boolean;
  config: XmppAccountConfig;
};

function listConfiguredAccountIds(cfg: CoreConfig): string[] {
  const accounts = cfg.channels?.xmpp?.accounts;
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

function resolveAccountConfig(cfg: CoreConfig, accountId: string): XmppAccountConfig | undefined {
  const accounts = cfg.channels?.xmpp?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const direct = accounts[accountId] as XmppAccountConfig | undefined;
  if (direct) {
    return direct;
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? (accounts[matchKey] as XmppAccountConfig | undefined) : undefined;
}

function mergeXmppAccountConfig(cfg: CoreConfig, accountId: string): XmppAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.xmpp ?? {}) as XmppAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  const merged: XmppAccountConfig = { ...base, ...account };
  return merged;
}

function resolvePassword(accountId: string, merged: XmppAccountConfig) {
  const passwordFile = merged.passwordFile?.trim();
  if (passwordFile) {
    try {
      const filePassword = readFileSync(passwordFile, "utf-8").trim();
      if (filePassword) {
        return { password: filePassword, source: "passwordFile" as const };
      }
    } catch {
      // Ignore unreadable files; status will still surface failures.
    }
  }

  const configPassword = merged.password?.trim();
  if (configPassword) {
    return { password: configPassword, source: "config" as const };
  }

  return { password: "", source: "none" as const };
}

export function listXmppAccountIds(cfg: CoreConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultXmppAccountId(cfg: CoreConfig): string {
  const ids = listXmppAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveXmppAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedXmppAccount {
  const hasExplicitAccountId = Boolean(params.accountId?.trim());
  const baseEnabled = params.cfg.channels?.xmpp?.enabled !== false;

  const resolve = (accountId: string): ResolvedXmppAccount => {
    const merged = mergeXmppAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;

    const jid = merged.jid?.trim() ?? "";
    const [, jidDomain] = jid.split("@");

    const server = (merged.server?.trim() || jidDomain || "").trim();
    const domain = (merged.domain?.trim() || jidDomain || "").trim() || undefined;
    const resource = merged.resource?.trim() || "openclaw";

    const tlsMode: XmppTlsMode = merged.tlsMode ?? "starttls";
    const tls =
      typeof merged.tls === "boolean" ? merged.tls : tlsMode === "tls" || tlsMode === "starttls";
    const port = merged.port ?? (tlsMode === "tls" ? 5223 : 5222);
    const allowSelfSignedTls = merged.allowSelfSignedTls ?? false;

    const passwordResolution = resolvePassword(accountId, merged);

    const config: XmppAccountConfig = {
      ...merged,
      jid,
      server,
      domain,
      resource,
      tls,
      tlsMode,
      port,
      allowSelfSignedTls,
    };

    const configured = Boolean(jid && server && passwordResolution.password);

    return {
      accountId,
      name: merged.name?.trim() || undefined,
      enabled,
      configured,
      jid,
      password: passwordResolution.password,
      passwordSource: passwordResolution.source,
      server,
      domain,
      resource,
      port,
      tls,
      tlsMode,
      allowSelfSignedTls,
      config,
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

  const fallbackId = resolveDefaultXmppAccountId(params.cfg);
  if (fallbackId === primary.accountId) {
    return primary;
  }
  const fallback = resolve(fallbackId);
  if (!fallback.configured) {
    return primary;
  }
  return fallback;
}
