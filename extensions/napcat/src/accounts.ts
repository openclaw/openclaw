import { DEFAULT_ACCOUNT_ID, normalizeAccountId, type OpenClawConfig } from "openclaw/plugin-sdk";
import type {
  NapCatConfig,
  ResolvedNapCatAccount,
  ResolvedNapCatTransportHttpConfig,
  ResolvedNapCatTransportWsConfig,
} from "./types.js";

export const DEFAULT_NAPCAT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_NAPCAT_HTTP_PORT = 5715;
export const DEFAULT_NAPCAT_HTTP_PATH = "/onebot";
export const DEFAULT_NAPCAT_HTTP_BODY_MAX_BYTES = 1024 * 1024;

export const DEFAULT_NAPCAT_WS_URL = "ws://127.0.0.1:3001";
export const DEFAULT_NAPCAT_WS_RECONNECT_MS = 3000;

function normalizeUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/g, "");
}

function normalizeHttpPath(value?: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return DEFAULT_NAPCAT_HTTP_PATH;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function resolveTransportHttp(config: NapCatConfig): ResolvedNapCatTransportHttpConfig {
  return {
    enabled: config.transport?.http?.enabled !== false,
    host: config.transport?.http?.host?.trim() || DEFAULT_NAPCAT_HTTP_HOST,
    port: config.transport?.http?.port ?? DEFAULT_NAPCAT_HTTP_PORT,
    path: normalizeHttpPath(config.transport?.http?.path),
    bodyMaxBytes: config.transport?.http?.bodyMaxBytes ?? DEFAULT_NAPCAT_HTTP_BODY_MAX_BYTES,
  };
}

function resolveTransportWs(config: NapCatConfig): ResolvedNapCatTransportWsConfig {
  return {
    enabled: config.transport?.ws?.enabled !== false,
    url: config.transport?.ws?.url?.trim() || DEFAULT_NAPCAT_WS_URL,
    reconnectMs: config.transport?.ws?.reconnectMs ?? DEFAULT_NAPCAT_WS_RECONNECT_MS,
  };
}

export function listNapCatAccountIds(_cfg: OpenClawConfig): string[] {
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultNapCatAccountId(_cfg: OpenClawConfig): string {
  return DEFAULT_ACCOUNT_ID;
}

export function resolveNapCatAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedNapCatAccount {
  const accountId = normalizeAccountId(params.accountId);
  const config = ((params.cfg.channels?.napcat as NapCatConfig | undefined) ?? {}) as NapCatConfig;

  const tokenFromConfig = config.token?.trim();
  const tokenFromEnv = process.env.NAPCAT_TOKEN?.trim();
  const token = tokenFromConfig || tokenFromEnv || undefined;
  const tokenSource = tokenFromConfig ? "config" : tokenFromEnv ? "env" : "none";

  const apiBaseUrlFromConfig = normalizeUrl(config.apiBaseUrl);
  const apiBaseUrlFromEnv = normalizeUrl(process.env.NAPCAT_API_BASE_URL);
  const apiBaseUrl = apiBaseUrlFromConfig || apiBaseUrlFromEnv;
  const apiBaseUrlSource = apiBaseUrlFromConfig ? "config" : apiBaseUrlFromEnv ? "env" : "none";

  const configured = Boolean(token && apiBaseUrl);

  return {
    accountId,
    name: config.name?.trim() || undefined,
    enabled: config.enabled !== false,
    configured,
    token,
    tokenSource,
    apiBaseUrl,
    apiBaseUrlSource,
    config,
    transport: {
      http: resolveTransportHttp(config),
      ws: resolveTransportWs(config),
    },
  };
}
