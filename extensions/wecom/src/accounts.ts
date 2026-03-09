import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { CoreConfig, WecomAccountConfig } from "./types.js";

export type ResolvedWecomAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  corpId: string;
  corpSecret: string;
  agentId: number;
  token: string;
  encodingAESKey: string;
  webhookPath: string;
  config: WecomAccountConfig;
};

function listConfiguredAccountIds(cfg: CoreConfig): string[] {
  const accounts = cfg.channels?.wecom?.accounts;
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

function resolveAccountConfig(cfg: CoreConfig, accountId: string): WecomAccountConfig | undefined {
  const accounts = cfg.channels?.wecom?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const direct = accounts[accountId] as WecomAccountConfig | undefined;
  if (direct) {
    return direct;
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? (accounts[matchKey] as WecomAccountConfig | undefined) : undefined;
}

function mergeWecomAccountConfig(cfg: CoreConfig, accountId: string): WecomAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.wecom ?? {}) as WecomAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function listWecomAccountIds(cfg: CoreConfig): string[] {
  const configured = listConfiguredAccountIds(cfg);
  if (configured.length > 0) {
    return configured;
  }
  const base = cfg.channels?.wecom;
  if (base?.corpId || process.env.WECOM_CORP_ID) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [];
}

export function resolveDefaultWecomAccountId(cfg: CoreConfig): string {
  const ids = listWecomAccountIds(cfg);
  return ids.length > 0 ? ids[0]! : DEFAULT_ACCOUNT_ID;
}

export function resolveWecomAccount(params: {
  cfg: CoreConfig;
  accountId?: string;
}): ResolvedWecomAccount {
  const { cfg } = params;
  const accountId = normalizeAccountId(params.accountId ?? DEFAULT_ACCOUNT_ID);
  const merged = mergeWecomAccountConfig(cfg, accountId);

  // Coerce to string — config may store numbers if set via CLI
  const coerce = (v: unknown): string => (v != null ? String(v).trim() : "");

  const corpId =
    coerce(merged.corpId) ||
    (accountId === DEFAULT_ACCOUNT_ID ? process.env.WECOM_CORP_ID?.trim() : undefined) ||
    "";
  const corpSecret =
    coerce(merged.corpSecret) ||
    (accountId === DEFAULT_ACCOUNT_ID ? process.env.WECOM_CORP_SECRET?.trim() : undefined) ||
    "";
  const agentId =
    merged.agentId ??
    (accountId === DEFAULT_ACCOUNT_ID && process.env.WECOM_AGENT_ID
      ? Number.parseInt(process.env.WECOM_AGENT_ID, 10)
      : 0);
  const token =
    coerce(merged.token) ||
    (accountId === DEFAULT_ACCOUNT_ID ? process.env.WECOM_TOKEN?.trim() : undefined) ||
    "";
  const encodingAESKey =
    coerce(merged.encodingAESKey) ||
    (accountId === DEFAULT_ACCOUNT_ID ? process.env.WECOM_ENCODING_AES_KEY?.trim() : undefined) ||
    "";
  const webhookPath = coerce(merged.webhookPath) || "/wecom";

  const enabled = merged.enabled !== false;
  const configured = Boolean(corpId && corpSecret && agentId);

  return {
    accountId,
    enabled,
    name: coerce(merged.name) || undefined,
    configured,
    corpId,
    corpSecret,
    agentId,
    token,
    encodingAESKey,
    webhookPath,
    config: merged,
  };
}
