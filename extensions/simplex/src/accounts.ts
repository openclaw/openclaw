import { DEFAULT_ACCOUNT_ID, normalizeAccountId, type OpenClawConfig } from "openclaw/plugin-sdk";
import type { SimplexAccountConfig, SimplexConfig } from "./config-schema.js";
import type {
  ResolvedSimplexAccount,
  SimplexConnectionConfig,
  SimplexConnectionMode,
} from "./types.js";

const DEFAULT_WS_HOST = "127.0.0.1";
const DEFAULT_WS_PORT = 5225;
const DEFAULT_CLI_PATH = "simplex-chat";

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = cfg.channels?.simplex?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listSimplexAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultSimplexAccountId(cfg: OpenClawConfig): string {
  const ids = listSimplexAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function mergeConnection(
  base: SimplexConnectionConfig = {},
  account: SimplexConnectionConfig = {},
): SimplexConnectionConfig {
  return {
    ...base,
    ...account,
  };
}

function mergeSimplexAccountConfig(cfg: OpenClawConfig, accountId: string): SimplexAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.simplex ?? {}) as SimplexConfig & {
    accounts?: unknown;
  };
  const account = (cfg.channels?.simplex?.accounts?.[accountId] ?? {}) as SimplexAccountConfig;
  return {
    ...base,
    ...account,
    connection: mergeConnection(base.connection, account.connection),
  };
}

function resolveWsHost(connection: SimplexConnectionConfig): string {
  return connection.wsHost?.trim() || DEFAULT_WS_HOST;
}

function resolveWsPort(connection: SimplexConnectionConfig): number {
  return connection.wsPort ?? DEFAULT_WS_PORT;
}

function resolveWsUrl(connection: SimplexConnectionConfig): string {
  if (connection.wsUrl?.trim()) {
    return connection.wsUrl.trim();
  }
  const host = resolveWsHost(connection);
  const port = resolveWsPort(connection);
  return `ws://${host}:${port}`;
}

export function resolveSimplexAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedSimplexAccount {
  const accountId = normalizeAccountId(params.accountId);
  const merged = mergeSimplexAccountConfig(params.cfg, accountId);
  const baseEnabled = params.cfg.channels?.simplex?.enabled !== false;
  const enabled = baseEnabled && merged.enabled !== false;
  const connection = merged.connection ?? {};
  const mode: SimplexConnectionMode = connection.mode ?? "managed";
  const explicitWsUrl = connection.wsUrl?.trim();
  const wsUrl = mode === "external" && !explicitWsUrl ? "" : resolveWsUrl(connection);
  const wsHost = resolveWsHost(connection);
  const wsPort = resolveWsPort(connection);
  const cliPath = connection.cliPath?.trim() || DEFAULT_CLI_PATH;
  const configured = mode === "external" ? Boolean(explicitWsUrl) : Boolean(cliPath);
  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    configured,
    mode,
    wsUrl,
    wsHost,
    wsPort,
    cliPath,
    dataDir: connection.dataDir?.trim() || undefined,
    config: merged,
  };
}

export function listEnabledSimplexAccounts(cfg: OpenClawConfig): ResolvedSimplexAccount[] {
  return listSimplexAccountIds(cfg)
    .map((accountId) => resolveSimplexAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
