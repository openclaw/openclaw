import {
  createAccountListHelpers,
  normalizeAccountId,
  resolveAccountEntry,
  resolveAccountWithDefaultFallback,
} from "openclaw/plugin-sdk/account-resolution";
import type { CoreConfig, ResolvedWechatLinuxAccount, WechatLinuxAccountConfig } from "./types.js";

const DEFAULT_KEY_FILE = "~/.wx_db_keys.json";
const DEFAULT_OUTPUT_DIR = "~/wx_decrypted";
const DEFAULT_PYTHON_PATH = "python3";
const DEFAULT_WINDOW_CLASS = "wechat";
const DEFAULT_WINDOW_MODE = "auto";

const {
  listAccountIds: listWechatLinuxAccountIdsInternal,
  resolveDefaultAccountId: resolveDefaultWechatLinuxAccountId,
} = createAccountListHelpers("wechat-linux", { normalizeAccountId });

export { resolveDefaultWechatLinuxAccountId };

export function listWechatLinuxAccountIds(cfg: CoreConfig): string[] {
  return listWechatLinuxAccountIdsInternal(cfg);
}

function resolveAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): WechatLinuxAccountConfig | undefined {
  return resolveAccountEntry(cfg.channels?.["wechat-linux"]?.accounts, accountId);
}

function mergeWechatLinuxAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): WechatLinuxAccountConfig {
  const {
    accounts: _ignored,
    defaultAccount: _ignoredDefaultAccount,
    ...base
  } = (cfg.channels?.["wechat-linux"] ?? {}) as WechatLinuxAccountConfig & {
    accounts?: unknown;
    defaultAccount?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function trimOptional(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeList(values?: string[]): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

export function resolveWechatLinuxAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedWechatLinuxAccount {
  const baseEnabled = params.cfg.channels?.["wechat-linux"]?.enabled !== false;

  const resolve = (accountId: string): ResolvedWechatLinuxAccount => {
    const merged = mergeWechatLinuxAccountConfig(params.cfg, accountId);
    const enabled = baseEnabled && merged.enabled !== false;
    const pyWxDumpRoot = trimOptional(merged.pyWxDumpRoot) ?? "";

    return {
      accountId,
      enabled,
      name: trimOptional(merged.name),
      configured: Boolean(pyWxDumpRoot),
      pyWxDumpRoot,
      pythonPath: trimOptional(merged.pythonPath) ?? DEFAULT_PYTHON_PATH,
      keyFile: trimOptional(merged.keyFile) ?? DEFAULT_KEY_FILE,
      dbDir: trimOptional(merged.dbDir),
      outputDir: trimOptional(merged.outputDir) ?? DEFAULT_OUTPUT_DIR,
      display: trimOptional(merged.display) ?? trimOptional(process.env.DISPLAY),
      xauthority: trimOptional(merged.xauthority) ?? trimOptional(process.env.XAUTHORITY),
      windowClass: trimOptional(merged.windowClass) ?? DEFAULT_WINDOW_CLASS,
      windowMode: merged.windowMode ?? DEFAULT_WINDOW_MODE,
      config: {
        ...merged,
        allowFrom: normalizeList(merged.allowFrom),
        groupAllowFrom: normalizeList(merged.groupAllowFrom),
        mentionPatterns: normalizeList(merged.mentionPatterns),
      },
    };
  };

  return resolveAccountWithDefaultFallback({
    accountId: params.accountId,
    normalizeAccountId,
    resolvePrimary: resolve,
    hasCredential: (account) => account.configured,
    resolveDefaultAccountId: () => resolveDefaultWechatLinuxAccountId(params.cfg),
  });
}

export function listEnabledWechatLinuxAccounts(cfg: CoreConfig): ResolvedWechatLinuxAccount[] {
  return listWechatLinuxAccountIds(cfg)
    .map((accountId) => resolveWechatLinuxAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
