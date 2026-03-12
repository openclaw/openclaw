import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { CoreConfig, MatrixAccountConfig, MatrixConfig } from "../types.js";

export function resolveMatrixBaseConfig(cfg: CoreConfig): MatrixConfig {
  return cfg.channels?.matrix ?? {};
}

function resolveMatrixAccountsMap(cfg: CoreConfig): Readonly<Record<string, MatrixAccountConfig>> {
  const accounts = resolveMatrixBaseConfig(cfg).accounts;
  if (!accounts || typeof accounts !== "object") {
    return {};
  }
  return accounts;
}

export function listNormalizedMatrixAccountIds(cfg: CoreConfig): string[] {
  return [
    ...new Set(
      Object.keys(resolveMatrixAccountsMap(cfg))
        .filter(Boolean)
        .map((accountId) => normalizeAccountId(accountId)),
    ),
  ];
}

export function findMatrixAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): MatrixAccountConfig | undefined {
  const accounts = resolveMatrixAccountsMap(cfg);
  if (accounts[accountId] && typeof accounts[accountId] === "object") {
    return accounts[accountId];
  }
  const normalized = normalizeAccountId(accountId);
  for (const key of Object.keys(accounts)) {
    if (normalizeAccountId(key) === normalized) {
      const candidate = accounts[key];
      if (candidate && typeof candidate === "object") {
        return candidate;
      }
      return undefined;
    }
  }
  return undefined;
}
