import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/pilot";
import { createAccountListHelpers } from "openclaw/plugin-sdk/pilot";
import type { CoreConfig, PilotAccountConfig } from "./types.js";

export type ResolvedPilotAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  hostname: string;
  socketPath: string;
  registry: string;
  pilotctlPath: string;
  pollIntervalMs: number;
  config: PilotAccountConfig;
};

const {
  listAccountIds: listPilotAccountIds,
  resolveDefaultAccountId: resolveDefaultPilotAccountId,
} = createAccountListHelpers("pilot", { normalizeAccountId });
export { listPilotAccountIds, resolveDefaultPilotAccountId };

function resolveAccountConfig(cfg: CoreConfig, accountId: string): PilotAccountConfig | undefined {
  const accounts = cfg.channels?.pilot?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const direct = accounts[accountId] as PilotAccountConfig | undefined;
  if (direct) {
    return direct;
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? (accounts[matchKey] as PilotAccountConfig | undefined) : undefined;
}

function mergePilotAccountConfig(cfg: CoreConfig, accountId: string): PilotAccountConfig {
  const {
    accounts: _ignored,
    defaultAccount: _ignoredDefaultAccount,
    ...base
  } = (cfg.channels?.pilot ?? {}) as PilotAccountConfig & {
    accounts?: unknown;
    defaultAccount?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolvePilotAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedPilotAccount {
  const hasExplicitAccountId = Boolean(params.accountId?.trim());
  const baseEnabled = params.cfg.channels?.pilot?.enabled !== false;

  const resolve = (accountId: string): ResolvedPilotAccount => {
    const merged = mergePilotAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;

    const hostname = (
      merged.hostname?.trim() ||
      (accountId === DEFAULT_ACCOUNT_ID ? process.env.PILOT_HOSTNAME?.trim() : "") ||
      ""
    ).trim();

    const socketPath = (
      merged.socketPath?.trim() ||
      (accountId === DEFAULT_ACCOUNT_ID ? process.env.PILOT_SOCKET?.trim() : "") ||
      "/tmp/pilot.sock"
    ).trim();

    const registry = (
      merged.registry?.trim() ||
      (accountId === DEFAULT_ACCOUNT_ID ? process.env.PILOT_REGISTRY?.trim() : "") ||
      ""
    ).trim();

    const pilotctlPath = (
      merged.pilotctlPath?.trim() ||
      (accountId === DEFAULT_ACCOUNT_ID ? process.env.PILOTCTL_PATH?.trim() : "") ||
      "pilotctl"
    ).trim();

    const pollIntervalMs = merged.pollIntervalMs ?? 2000;

    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      configured: Boolean(hostname),
      hostname,
      socketPath,
      registry,
      pilotctlPath,
      pollIntervalMs,
      config: {
        ...merged,
        hostname,
        socketPath,
        registry,
        pilotctlPath,
        pollIntervalMs,
      },
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

  const fallbackId = resolveDefaultPilotAccountId(params.cfg);
  if (fallbackId === primary.accountId) {
    return primary;
  }
  const fallback = resolve(fallbackId);
  if (!fallback.configured) {
    return primary;
  }
  return fallback;
}

export function listEnabledPilotAccounts(cfg: CoreConfig): ResolvedPilotAccount[] {
  return listPilotAccountIds(cfg)
    .map((accountId) => resolvePilotAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
