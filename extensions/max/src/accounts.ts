import type { OpenClawConfig } from "openclaw/plugin-sdk";
import fs from "node:fs";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { MaxAccountConfig, ResolvedMaxAccount } from "./types.js";

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = (cfg.channels as Record<string, unknown> | undefined)?.max as
    | { accounts?: Record<string, unknown> }
    | undefined;
  if (!accounts?.accounts || typeof accounts.accounts !== "object") {
    return [];
  }
  const ids = new Set<string>();
  for (const key of Object.keys(accounts.accounts)) {
    if (!key) {
      continue;
    }
    ids.add(normalizeAccountId(key));
  }
  return [...ids];
}

export function listMaxAccountIds(cfg: OpenClawConfig): string[] {
  const ids = Array.from(new Set(listConfiguredAccountIds(cfg)));
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultMaxAccountId(cfg: OpenClawConfig): string {
  const ids = listMaxAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function getMaxChannelConfig(
  cfg: OpenClawConfig,
): MaxAccountConfig & { accounts?: Record<string, MaxAccountConfig> } {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  return (channels?.max ?? {}) as MaxAccountConfig & {
    accounts?: Record<string, MaxAccountConfig>;
  };
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): MaxAccountConfig | undefined {
  const maxCfg = getMaxChannelConfig(cfg);
  const accounts = maxCfg.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const direct = accounts[accountId];
  if (direct) {
    return direct;
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? accounts[matchKey] : undefined;
}

function mergeMaxAccountConfig(cfg: OpenClawConfig, accountId: string): MaxAccountConfig {
  const maxCfg = getMaxChannelConfig(cfg);
  const { accounts: _ignored, ...base } = maxCfg;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function tryReadTokenFile(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  try {
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    return "";
  }
}

function resolveMaxToken(
  cfg: OpenClawConfig,
  accountId: string,
): { token: string; source: ResolvedMaxAccount["tokenSource"] } {
  const merged = mergeMaxAccountConfig(cfg, accountId);

  // 1. Token file (per-account or base)
  const tokenFile = merged.tokenFile?.trim();
  if (tokenFile) {
    const fileToken = tryReadTokenFile(tokenFile);
    if (fileToken) {
      return { token: fileToken, source: "tokenFile" };
    }
    return { token: "", source: "none" };
  }

  // 2. Config token (per-account or base)
  const configToken = merged.botToken?.trim() ?? "";
  if (configToken) {
    return { token: configToken, source: "config" };
  }

  // 3. Environment variable (default account only)
  const envToken = process.env.MAX_BOT_TOKEN?.trim() ?? "";
  if (envToken && accountId === DEFAULT_ACCOUNT_ID) {
    return { token: envToken, source: "env" };
  }

  // 4. No token
  return { token: "", source: "none" };
}

export function resolveMaxAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedMaxAccount {
  const hasExplicitAccountId = Boolean(params.accountId?.trim());
  const maxCfg = getMaxChannelConfig(params.cfg);
  const baseEnabled = maxCfg.enabled !== false;

  const resolve = (accountId: string) => {
    const merged = mergeMaxAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const tokenResolution = resolveMaxToken(params.cfg, accountId);
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      token: tokenResolution.token,
      tokenSource: tokenResolution.source,
      config: merged,
    } satisfies ResolvedMaxAccount;
  };

  const normalized = normalizeAccountId(params.accountId);
  const primary = resolve(normalized);
  if (hasExplicitAccountId) {
    return primary;
  }
  if (primary.tokenSource !== "none") {
    return primary;
  }

  const fallbackId = resolveDefaultMaxAccountId(params.cfg);
  if (fallbackId === primary.accountId) {
    return primary;
  }
  const fallback = resolve(fallbackId);
  if (fallback.tokenSource === "none") {
    return primary;
  }
  return fallback;
}
