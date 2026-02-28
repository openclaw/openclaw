import fs from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { TypeXAccountConfig } from "../types.js";

export type TypeXTokenSource = "config" | "file" | "env" | "none";

export type ResolvedTypeXAccount = {
  accountId: string;
  config: TypeXAccountConfig;
  tokenSource: TypeXTokenSource;
  name?: string;
  enabled: boolean;
};

function readFileIfExists(filePath?: string): string | undefined {
  if (!filePath) {
    return undefined;
  }
  try {
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    return undefined;
  }
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TypeXAccountConfig | undefined {
  const accounts = cfg.channels?.["typex"]?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const direct = accounts[accountId] as TypeXAccountConfig | undefined;
  if (direct) {
    return direct;
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? (accounts[matchKey] as TypeXAccountConfig | undefined) : undefined;
}

function mergeTypeXAccountConfig(cfg: OpenClawConfig, accountId: string): TypeXAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.["typex"] ?? {}) as TypeXAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function resolveAppSecret(config?: { appSecret?: string; appSecretFile?: string }): {
  value?: string;
  source?: Exclude<TypeXTokenSource, "env" | "none">;
} {
  const direct = config?.appSecret?.trim();
  if (direct) {
    return { value: direct, source: "config" };
  }
  const fromFile = readFileIfExists(config?.appSecretFile);
  if (fromFile) {
    return { value: fromFile, source: "file" };
  }
  return {};
}

export function listTypeXAccountIds(cfg: OpenClawConfig): string[] {
  const typexCfg = cfg.channels?.["typex"];
  const accounts = typexCfg?.accounts;
  const ids = new Set<string>();

  const baseConfigured = Boolean(
    typexCfg?.appId?.trim() && (typexCfg?.appSecret?.trim() || Boolean(typexCfg?.appSecretFile)),
  );
  const envConfigured = Boolean(
    process.env.TYPEX_APP_ID?.trim() && process.env.TYPEX_APP_SECRET?.trim(),
  );
  if (baseConfigured || envConfigured) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  if (accounts) {
    for (const id of Object.keys(accounts)) {
      ids.add(normalizeAccountId(id));
    }
  }

  return Array.from(ids);
}

export function resolveDefaultTypeXAccountId(cfg: OpenClawConfig): string {
  const configuredDefault = cfg.channels?.["typex"]?.defaultAccount?.trim();
  if (configuredDefault) {
    return normalizeAccountId(configuredDefault);
  }
  const ids = listTypeXAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveTypeXAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedTypeXAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.["typex"]?.enabled !== false;
  const merged = mergeTypeXAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envAppId = allowEnv ? process.env.TYPEX_APP_ID?.trim() : undefined;
  const envAppSecret = allowEnv ? process.env.TYPEX_APP_SECRET?.trim() : undefined;

  const appId = merged.appId?.trim() || envAppId || "";
  const secretResolution = resolveAppSecret(merged);
  const appSecret = secretResolution.value ?? envAppSecret ?? "";

  let tokenSource: TypeXTokenSource = "none";
  if (secretResolution.value) {
    tokenSource = secretResolution.source ?? "config";
  } else if (envAppSecret) {
    tokenSource = "env";
  }
  if (!appId || !appSecret) {
    tokenSource = "none";
  }

  const config: TypeXAccountConfig = {
    ...merged,
    appId,
    appSecret,
  };

  const name = config.name?.trim() || config.botName?.trim() || undefined;

  return {
    accountId,
    config,
    tokenSource,
    name,
    enabled,
  };
}
