import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { listMatrixEnvAccountIds } from "./env-vars.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function resolveMatrixChannelConfig(cfg: OpenClawConfig): Record<string, unknown> | null {
  return isRecord(cfg.channels?.matrix) ? cfg.channels.matrix : null;
}

export function findMatrixAccountEntry(
  cfg: OpenClawConfig,
  accountId: string,
): Record<string, unknown> | null {
  const channel = resolveMatrixChannelConfig(cfg);
  if (!channel) {
    return null;
  }

  const accounts = isRecord(channel.accounts) ? channel.accounts : null;
  if (!accounts) {
    return null;
  }

  const normalizedAccountId = normalizeAccountId(accountId);
  for (const [rawAccountId, value] of Object.entries(accounts)) {
    if (normalizeAccountId(rawAccountId) === normalizedAccountId && isRecord(value)) {
      return value;
    }
  }

  return null;
}

export function resolveConfiguredMatrixAccountIds(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const channel = resolveMatrixChannelConfig(cfg);
  const ids = new Set<string>(listMatrixEnvAccountIds(env));

  const accounts = channel && isRecord(channel.accounts) ? channel.accounts : null;
  if (accounts) {
    for (const [accountId, value] of Object.entries(accounts)) {
      if (isRecord(value)) {
        ids.add(normalizeAccountId(accountId));
      }
    }
  }

  if (ids.size === 0 && channel) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  return Array.from(ids).toSorted((a, b) => a.localeCompare(b));
}

export function resolveMatrixDefaultOrOnlyAccountId(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const channel = resolveMatrixChannelConfig(cfg);
  if (!channel) {
    return DEFAULT_ACCOUNT_ID;
  }

  const configuredDefault = normalizeOptionalAccountId(
    typeof channel.defaultAccount === "string" ? channel.defaultAccount : undefined,
  );
  const configuredAccountIds = resolveConfiguredMatrixAccountIds(cfg, env);
  if (configuredDefault && configuredAccountIds.includes(configuredDefault)) {
    return configuredDefault;
  }
  if (configuredAccountIds.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }

  if (configuredAccountIds.length === 1) {
    return configuredAccountIds[0] ?? DEFAULT_ACCOUNT_ID;
  }
  return DEFAULT_ACCOUNT_ID;
}

export function requiresExplicitMatrixDefaultAccount(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const channel = resolveMatrixChannelConfig(cfg);
  if (!channel) {
    return false;
  }
  const configuredAccountIds = resolveConfiguredMatrixAccountIds(cfg, env);
  if (configuredAccountIds.length <= 1) {
    return false;
  }
  const configuredDefault = normalizeOptionalAccountId(
    typeof channel.defaultAccount === "string" ? channel.defaultAccount : undefined,
  );
  return !(configuredDefault && configuredAccountIds.includes(configuredDefault));
}
