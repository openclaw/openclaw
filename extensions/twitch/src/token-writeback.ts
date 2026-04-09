import {
  readConfigFileSnapshotForWrite,
  writeConfigFile,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/config-runtime";
import { DEFAULT_ACCOUNT_ID } from "./config.js";

type TwitchTokenSource = "config" | "env" | "none";

export type RefreshedTwitchToken = {
  accessToken: string;
  refreshToken?: string | null;
  expiresIn?: number | null;
  obtainmentTimestamp?: number | null;
};

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function ensureObjectRecord(holder: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = asObjectRecord(holder[key]);
  if (existing) {
    return existing;
  }
  const next: Record<string, unknown> = {};
  holder[key] = next;
  return next;
}

function normalizeStoredAccessToken(accessToken: string): string {
  const trimmed = accessToken.trim();
  return trimmed.startsWith("oauth:") ? trimmed : `oauth:${trimmed}`;
}

function updateTokenFields(holder: Record<string, unknown>, token: RefreshedTwitchToken): boolean {
  let changed = false;
  const nextAccessToken = normalizeStoredAccessToken(token.accessToken);
  if (holder.accessToken !== nextAccessToken) {
    holder.accessToken = nextAccessToken;
    changed = true;
  }

  if (typeof token.refreshToken === "string" && token.refreshToken.trim()) {
    const nextRefreshToken = token.refreshToken.trim();
    if (holder.refreshToken !== nextRefreshToken) {
      holder.refreshToken = nextRefreshToken;
      changed = true;
    }
  }

  const nextExpiresIn = typeof token.expiresIn === "number" ? token.expiresIn : null;
  if (holder.expiresIn !== nextExpiresIn) {
    holder.expiresIn = nextExpiresIn;
    changed = true;
  }

  const nextObtainmentTimestamp =
    typeof token.obtainmentTimestamp === "number" ? token.obtainmentTimestamp : Date.now();
  if (holder.obtainmentTimestamp !== nextObtainmentTimestamp) {
    holder.obtainmentTimestamp = nextObtainmentTimestamp;
    changed = true;
  }

  return changed;
}

function resolveDefaultAccountHolder(twitch: Record<string, unknown>): Record<string, unknown> {
  if (typeof twitch.accessToken === "string" && twitch.accessToken.trim()) {
    return twitch;
  }
  const accounts = ensureObjectRecord(twitch, "accounts");
  return ensureObjectRecord(accounts, DEFAULT_ACCOUNT_ID);
}

function resolveAccountHolder(cfg: OpenClawConfig, accountId: string): Record<string, unknown> {
  const root = cfg as Record<string, unknown>;
  const channels = ensureObjectRecord(root, "channels");
  const twitch = ensureObjectRecord(channels, "twitch");

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return resolveDefaultAccountHolder(twitch);
  }

  const accounts = ensureObjectRecord(twitch, "accounts");
  return ensureObjectRecord(accounts, accountId);
}

export async function persistRefreshedTwitchTokens(params: {
  accountId?: string | null;
  tokenSource: TwitchTokenSource;
  token: RefreshedTwitchToken;
}): Promise<boolean> {
  if (params.tokenSource !== "config") {
    return false;
  }

  if (!params.token.accessToken.trim()) {
    return false;
  }

  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  const nextConfig = structuredClone(snapshot.config ?? {}) as OpenClawConfig;
  const holder = resolveAccountHolder(nextConfig, params.accountId?.trim() || DEFAULT_ACCOUNT_ID);
  const changed = updateTokenFields(holder, params.token);
  if (!changed) {
    return false;
  }

  await writeConfigFile(nextConfig, writeOptions);
  return true;
}
