import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";

// Binding helpers are not available in the plugin runtime image (src/ is excluded).
// We don't use agent bindings — inline no-ops that match the function signatures.
const listBoundAccountIds = (_cfg: unknown, _channelId: string): string[] => [];
const resolveDefaultAgentBoundAccountId = (_cfg: unknown, _channelId: string): string | null => null;

import type { CommonlyConfig } from "./config-schema.js";

export interface CommonlyAccountConfig extends CommonlyConfig {}

export interface ResolvedCommonlyAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  baseUrl: string;
  runtimeToken: string;
  userToken?: string;
  agentName: string;
  instanceId: string;
  podIds: string[];
  config: CommonlyAccountConfig;
}

const resolveCommonlyConfig = (cfg: OpenClawConfig): CommonlyAccountConfig | undefined => {
  return (cfg.channels as Record<string, unknown> | undefined)?.commonly as
    | CommonlyAccountConfig
    | undefined;
};

const resolveAccountConfig = (
  cfg: OpenClawConfig,
  accountId: string,
): CommonlyAccountConfig | undefined => {
  const commonlyCfg = resolveCommonlyConfig(cfg);
  const accounts = commonlyCfg?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  const direct = accounts[accountId as keyof typeof accounts] as CommonlyAccountConfig | undefined;
  if (direct) return direct;
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find(
    (key) => normalizeAccountId(key) === normalized,
  );
  return matchKey ? (accounts[matchKey] as CommonlyAccountConfig | undefined) : undefined;
};

const mergeCommonlyAccountConfig = (
  cfg: OpenClawConfig,
  accountId: string,
): CommonlyAccountConfig => {
  const commonlyCfg = resolveCommonlyConfig(cfg);
  const { accounts: _ignored, ...base } = (commonlyCfg ?? {}) as CommonlyAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
};

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

export function listCommonlyAccountIds(cfg: OpenClawConfig): string[] {
  const commonlyCfg = resolveCommonlyConfig(cfg);
  const accounts = commonlyCfg?.accounts;
  const configured = accounts && typeof accounts === "object" ? Object.keys(accounts) : [];
  const bound = listBoundAccountIds(cfg, "commonly");
  const ids = Array.from(
    new Set([...configured.map((id) => normalizeAccountId(id)), ...bound]),
  );

  if (ids.length > 0) {
    return ids.sort((a, b) => a.localeCompare(b));
  }

  const hasBaseUrl = Boolean(normalizeString(commonlyCfg?.baseUrl));
  const hasRuntimeToken = Boolean(
    normalizeString(commonlyCfg?.runtimeToken) ??
      normalizeString(process.env.OPENCLAW_RUNTIME_TOKEN),
  );
  if (hasBaseUrl || hasRuntimeToken) {
    return [DEFAULT_ACCOUNT_ID];
  }

  return [];
}

export function resolveDefaultCommonlyAccountId(cfg: OpenClawConfig): string {
  const boundDefault = resolveDefaultAgentBoundAccountId(cfg, "commonly");
  if (boundDefault) return boundDefault;
  const ids = listCommonlyAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveCommonlyAccount(opts: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedCommonlyAccount {
  const hasExplicitAccountId = Boolean(opts.accountId?.trim());
  const normalized = normalizeAccountId(opts.accountId);
  const accountId = normalized || DEFAULT_ACCOUNT_ID;
  const buildAccount = (
    resolvedId: string,
    config: CommonlyAccountConfig,
  ): ResolvedCommonlyAccount => {
    const baseUrl =
      normalizeString(config.baseUrl) ??
      normalizeString(process.env.COMMONLY_API_URL) ??
      normalizeString(process.env.COMMONLY_BASE_URL) ??
      "http://localhost:5000";
    const runtimeToken =
      normalizeString(config.runtimeToken) ?? normalizeString(process.env.OPENCLAW_RUNTIME_TOKEN) ?? "";
    const userToken =
      normalizeString(config.userToken) ?? normalizeString(process.env.OPENCLAW_USER_TOKEN);
    const agentName = normalizeString(config.agentName) ?? "openclaw";
    const instanceId = normalizeString(config.instanceId) ?? "default";
    const podIds = Array.isArray(config.podIds)
      ? config.podIds.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean)
      : [];
    const enabled = config.enabled !== false;
    const configured = Boolean(baseUrl && runtimeToken);

    return {
      accountId: resolvedId,
      name: normalizeString(config.name),
      enabled,
      configured,
      baseUrl,
      runtimeToken,
      userToken,
      agentName,
      instanceId,
      podIds,
      config,
    };
  };

  const resolved = buildAccount(accountId, mergeCommonlyAccountConfig(opts.cfg, accountId));

  if (hasExplicitAccountId) return resolved;
  if (resolved.configured) return resolved;

  const fallbackId = resolveDefaultCommonlyAccountId(opts.cfg);
  if (fallbackId === accountId) return resolved;
  const fallback = buildAccount(fallbackId, mergeCommonlyAccountConfig(opts.cfg, fallbackId));
  return fallback.configured ? fallback : resolved;
}
