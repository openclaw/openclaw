import { readFileSync } from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { privateKeyToAccount } from "viem/accounts";

export interface XmtpAccountConfig {
  enabled?: boolean;
  name?: string;
  walletKey?: string;
  walletKeyFile?: string;
  dbEncryptionKey?: string;
  dbEncryptionKeyFile?: string;
  env?: "local" | "dev" | "production";
  dbPath?: string;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: string[];
}

export type XmtpSecretSource = "env" | "secretFile" | "config" | "none";

export interface ResolvedXmtpAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  walletKey: string;
  walletKeySource: XmtpSecretSource;
  dbEncryptionKey: string;
  dbEncryptionKeySource: XmtpSecretSource;
  address: string;
  env: "local" | "dev" | "production";
  config: XmtpAccountConfig;
}

const DEFAULT_ACCOUNT_ID = "default";
const DEFAULT_ENV = "production" as const;

function deriveAddressFromKey(walletKey: string): string {
  try {
    const account = privateKeyToAccount(walletKey as `0x${string}`);
    return account.address.toLowerCase();
  } catch {
    return "";
  }
}

export function listXmtpAccountIds(cfg: OpenClawConfig): string[] {
  const xmtpCfg = (cfg.channels as Record<string, unknown> | undefined)?.xmtp as
    | XmtpAccountConfig
    | undefined;

  const hasConfig =
    Boolean(xmtpCfg?.walletKey?.trim()) ||
    Boolean(xmtpCfg?.walletKeyFile?.trim()) ||
    Boolean(xmtpCfg?.dbEncryptionKey?.trim()) ||
    Boolean(xmtpCfg?.dbEncryptionKeyFile?.trim());
  const hasEnv =
    Boolean(process.env.XMTP_WALLET_KEY?.trim()) ||
    Boolean(process.env.XMTP_DB_ENCRYPTION_KEY?.trim());

  if (hasConfig || hasEnv) {
    return [DEFAULT_ACCOUNT_ID];
  }

  return [];
}

export function resolveDefaultXmtpAccountId(cfg: OpenClawConfig): string {
  const ids = listXmtpAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveXmtpAccount(opts: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedXmtpAccount {
  const accountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;
  const xmtpCfg = (opts.cfg.channels as Record<string, unknown> | undefined)?.xmtp as
    | XmtpAccountConfig
    | undefined;

  const baseEnabled = xmtpCfg?.enabled !== false;
  const walletKeyResolution = resolveWalletKey(accountId, xmtpCfg);
  const dbEncryptionKeyResolution = resolveDbEncryptionKey(accountId, xmtpCfg);
  const configured = Boolean(walletKeyResolution.secret && dbEncryptionKeyResolution.secret);

  let address = "";
  if (configured) {
    address = deriveAddressFromKey(walletKeyResolution.secret);
  }

  return {
    accountId,
    name: xmtpCfg?.name?.trim() || undefined,
    enabled: baseEnabled,
    configured,
    walletKey: walletKeyResolution.secret,
    walletKeySource: walletKeyResolution.source,
    dbEncryptionKey: dbEncryptionKeyResolution.secret,
    dbEncryptionKeySource: dbEncryptionKeyResolution.source,
    address,
    env: xmtpCfg?.env ?? DEFAULT_ENV,
    config: {
      enabled: xmtpCfg?.enabled,
      name: xmtpCfg?.name,
      walletKey: xmtpCfg?.walletKey,
      walletKeyFile: xmtpCfg?.walletKeyFile,
      dbEncryptionKey: xmtpCfg?.dbEncryptionKey,
      dbEncryptionKeyFile: xmtpCfg?.dbEncryptionKeyFile,
      env: xmtpCfg?.env,
      dbPath: xmtpCfg?.dbPath,
      dmPolicy: xmtpCfg?.dmPolicy,
      allowFrom: xmtpCfg?.allowFrom,
    },
  };
}

function resolveWalletKey(
  accountId: string,
  cfg?: XmtpAccountConfig,
): { secret: string; source: XmtpSecretSource } {
  const walletKeyFile = cfg?.walletKeyFile?.trim();
  if (walletKeyFile) {
    try {
      const secret = readFileSync(walletKeyFile, "utf-8").trim();
      if (secret) {
        return { secret, source: "secretFile" };
      }
    } catch {
      return { secret: "", source: "none" };
    }
  }

  const configKey = cfg?.walletKey?.trim();
  if (configKey) {
    return { secret: configKey, source: "config" };
  }

  if (accountId === DEFAULT_ACCOUNT_ID) {
    const envKey = process.env.XMTP_WALLET_KEY?.trim();
    if (envKey) {
      return { secret: envKey, source: "env" };
    }
  }

  return { secret: "", source: "none" };
}

function resolveDbEncryptionKey(
  accountId: string,
  cfg?: XmtpAccountConfig,
): { secret: string; source: XmtpSecretSource } {
  const secretFile = cfg?.dbEncryptionKeyFile?.trim();
  if (secretFile) {
    try {
      const secret = readFileSync(secretFile, "utf-8").trim();
      if (secret) {
        return { secret, source: "secretFile" };
      }
    } catch {
      return { secret: "", source: "none" };
    }
  }

  const configKey = cfg?.dbEncryptionKey?.trim();
  if (configKey) {
    return { secret: configKey, source: "config" };
  }

  if (accountId === DEFAULT_ACCOUNT_ID) {
    const envKey = process.env.XMTP_DB_ENCRYPTION_KEY?.trim();
    if (envKey) {
      return { secret: envKey, source: "env" };
    }
  }

  return { secret: "", source: "none" };
}
