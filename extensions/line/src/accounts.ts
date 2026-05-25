import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId as normalizeSharedAccountId,
  normalizeOptionalAccountId,
} from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { resolveAccountEntry } from "openclaw/plugin-sdk/account-resolution";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/core";
import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
  normalizeResolvedSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import type {
  LineAccountConfig,
  LineConfig,
  LineTokenSource,
  ResolvedLineAccount,
} from "./types.js";

export { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";

export type LineCredentialStatus = "available" | "configured_unavailable" | "missing";

export type InspectedLineAccount = ResolvedLineAccount & {
  configured: boolean;
  tokenStatus: LineCredentialStatus;
  signingSecretStatus: LineCredentialStatus;
};

function readFileIfExists(filePath: string | undefined): string | undefined {
  return tryReadSecretFileSync(filePath, "LINE credential file", { rejectSymlink: true });
}

function inspectSecretValue(value: unknown): {
  value: string;
  status: LineCredentialStatus;
} | null {
  const normalized = normalizeSecretInputString(value);
  if (normalized) {
    return {
      value: normalized,
      status: "available",
    };
  }
  if (hasConfiguredSecretInput(value)) {
    return {
      value: "",
      status: "configured_unavailable",
    };
  }
  return null;
}

function inspectFileValue(filePath: string | undefined): {
  value: string;
  status: LineCredentialStatus;
} | null {
  if (!filePath?.trim()) {
    return null;
  }
  const value = readFileIfExists(filePath);
  return {
    value: value ?? "",
    status: value ? "available" : "configured_unavailable",
  };
}

function resolveToken(params: {
  accountId: string;
  baseConfig?: LineConfig;
  accountConfig?: LineAccountConfig;
}): { token: string; tokenSource: LineTokenSource } {
  const { accountId, baseConfig, accountConfig } = params;

  const accountConfigToken = normalizeResolvedSecretInputString({
    value: accountConfig?.channelAccessToken,
    path: `channels.line.accounts.${accountId}.channelAccessToken`,
  });
  if (accountConfigToken) {
    return { token: accountConfigToken, tokenSource: "config" };
  }

  const accountFileToken = readFileIfExists(accountConfig?.tokenFile);
  if (accountFileToken) {
    return { token: accountFileToken, tokenSource: "file" };
  }

  if (accountId === DEFAULT_ACCOUNT_ID) {
    const baseConfigToken = normalizeResolvedSecretInputString({
      value: baseConfig?.channelAccessToken,
      path: "channels.line.channelAccessToken",
    });
    if (baseConfigToken) {
      return { token: baseConfigToken, tokenSource: "config" };
    }

    const baseFileToken = readFileIfExists(baseConfig?.tokenFile);
    if (baseFileToken) {
      return { token: baseFileToken, tokenSource: "file" };
    }

    const envToken = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
    if (envToken) {
      return { token: envToken, tokenSource: "env" };
    }
  }

  return { token: "", tokenSource: "none" };
}

function resolveSecret(params: {
  accountId: string;
  baseConfig?: LineConfig;
  accountConfig?: LineAccountConfig;
}): string {
  const { accountId, baseConfig, accountConfig } = params;

  const accountConfigSecret = normalizeResolvedSecretInputString({
    value: accountConfig?.channelSecret,
    path: `channels.line.accounts.${accountId}.channelSecret`,
  });
  if (accountConfigSecret) {
    return accountConfigSecret;
  }

  const accountFileSecret = readFileIfExists(accountConfig?.secretFile);
  if (accountFileSecret) {
    return accountFileSecret;
  }

  if (accountId === DEFAULT_ACCOUNT_ID) {
    const baseConfigSecret = normalizeResolvedSecretInputString({
      value: baseConfig?.channelSecret,
      path: "channels.line.channelSecret",
    });
    if (baseConfigSecret) {
      return baseConfigSecret;
    }

    const baseFileSecret = readFileIfExists(baseConfig?.secretFile);
    if (baseFileSecret) {
      return baseFileSecret;
    }

    const envSecret = process.env.LINE_CHANNEL_SECRET?.trim();
    if (envSecret) {
      return envSecret;
    }
  }

  return "";
}

function inspectToken(params: {
  accountId: string;
  baseConfig?: LineConfig;
  accountConfig?: LineAccountConfig;
}): { token: string; tokenSource: LineTokenSource; tokenStatus: LineCredentialStatus } {
  const { accountId, baseConfig, accountConfig } = params;

  const accountConfigToken = inspectSecretValue(accountConfig?.channelAccessToken);
  if (accountConfigToken) {
    return {
      token: accountConfigToken.value,
      tokenSource: "config",
      tokenStatus: accountConfigToken.status,
    };
  }

  const accountFileToken = inspectFileValue(accountConfig?.tokenFile);
  if (accountFileToken) {
    return {
      token: accountFileToken.value,
      tokenSource: "file",
      tokenStatus: accountFileToken.status,
    };
  }

  if (accountId === DEFAULT_ACCOUNT_ID) {
    const baseConfigToken = inspectSecretValue(baseConfig?.channelAccessToken);
    if (baseConfigToken) {
      return {
        token: baseConfigToken.value,
        tokenSource: "config",
        tokenStatus: baseConfigToken.status,
      };
    }

    const baseFileToken = inspectFileValue(baseConfig?.tokenFile);
    if (baseFileToken) {
      return {
        token: baseFileToken.value,
        tokenSource: "file",
        tokenStatus: baseFileToken.status,
      };
    }

    const envToken = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
    if (envToken) {
      return { token: envToken, tokenSource: "env", tokenStatus: "available" };
    }
  }

  return { token: "", tokenSource: "none", tokenStatus: "missing" };
}

function inspectSecret(params: {
  accountId: string;
  baseConfig?: LineConfig;
  accountConfig?: LineAccountConfig;
}): { secret: string; secretStatus: LineCredentialStatus } {
  const { accountId, baseConfig, accountConfig } = params;

  const accountConfigSecret = inspectSecretValue(accountConfig?.channelSecret);
  if (accountConfigSecret) {
    return {
      secret: accountConfigSecret.value,
      secretStatus: accountConfigSecret.status,
    };
  }

  const accountFileSecret = inspectFileValue(accountConfig?.secretFile);
  if (accountFileSecret) {
    return {
      secret: accountFileSecret.value,
      secretStatus: accountFileSecret.status,
    };
  }

  if (accountId === DEFAULT_ACCOUNT_ID) {
    const baseConfigSecret = inspectSecretValue(baseConfig?.channelSecret);
    if (baseConfigSecret) {
      return {
        secret: baseConfigSecret.value,
        secretStatus: baseConfigSecret.status,
      };
    }

    const baseFileSecret = inspectFileValue(baseConfig?.secretFile);
    if (baseFileSecret) {
      return {
        secret: baseFileSecret.value,
        secretStatus: baseFileSecret.status,
      };
    }

    const envSecret = process.env.LINE_CHANNEL_SECRET?.trim();
    if (envSecret) {
      return { secret: envSecret, secretStatus: "available" };
    }
  }

  return { secret: "", secretStatus: "missing" };
}

function mergeLineAccountConfig(params: {
  lineConfig?: LineConfig;
  accountConfig?: LineAccountConfig;
}): LineConfig & LineAccountConfig {
  const {
    accounts: _ignoredAccounts,
    defaultAccount: _ignoredDefaultAccount,
    ...lineBase
  } = (params.lineConfig ?? {}) as LineConfig & {
    accounts?: unknown;
    defaultAccount?: unknown;
  };
  return {
    ...lineBase,
    ...params.accountConfig,
  };
}

export function resolveLineAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedLineAccount {
  const cfg = params.cfg;
  const accountId = normalizeSharedAccountId(params.accountId ?? resolveDefaultLineAccountId(cfg));
  const lineConfig = cfg.channels?.line as LineConfig | undefined;
  const accounts = lineConfig?.accounts;
  const accountConfig =
    accountId !== DEFAULT_ACCOUNT_ID ? resolveAccountEntry(accounts, accountId) : undefined;

  const { token, tokenSource } = resolveToken({
    accountId,
    baseConfig: lineConfig,
    accountConfig,
  });

  const secret = resolveSecret({
    accountId,
    baseConfig: lineConfig,
    accountConfig,
  });

  const mergedConfig = mergeLineAccountConfig({ lineConfig, accountConfig });

  const enabled =
    accountConfig?.enabled ??
    (accountId === DEFAULT_ACCOUNT_ID ? (lineConfig?.enabled ?? true) : false);

  const name =
    accountConfig?.name ?? (accountId === DEFAULT_ACCOUNT_ID ? lineConfig?.name : undefined);

  return {
    accountId,
    name,
    enabled,
    channelAccessToken: token,
    channelSecret: secret,
    tokenSource,
    config: mergedConfig,
  };
}

export function inspectLineAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): InspectedLineAccount {
  const cfg = params.cfg;
  const accountId = normalizeSharedAccountId(params.accountId ?? resolveDefaultLineAccountId(cfg));
  const lineConfig = cfg.channels?.line as LineConfig | undefined;
  const accounts = lineConfig?.accounts;
  const accountConfig =
    accountId !== DEFAULT_ACCOUNT_ID ? resolveAccountEntry(accounts, accountId) : undefined;
  const { token, tokenSource, tokenStatus } = inspectToken({
    accountId,
    baseConfig: lineConfig,
    accountConfig,
  });
  const { secret, secretStatus } = inspectSecret({
    accountId,
    baseConfig: lineConfig,
    accountConfig,
  });
  const mergedConfig = mergeLineAccountConfig({ lineConfig, accountConfig });

  const enabled =
    accountConfig?.enabled ??
    (accountId === DEFAULT_ACCOUNT_ID ? (lineConfig?.enabled ?? true) : false);

  const name =
    accountConfig?.name ?? (accountId === DEFAULT_ACCOUNT_ID ? lineConfig?.name : undefined);

  return {
    accountId,
    name,
    enabled,
    channelAccessToken: token,
    channelSecret: secret,
    tokenSource,
    config: mergedConfig,
    configured: tokenStatus !== "missing" && secretStatus !== "missing",
    tokenStatus,
    signingSecretStatus: secretStatus,
  };
}

export function listLineAccountIds(cfg: OpenClawConfig): string[] {
  const lineConfig = cfg.channels?.line as LineConfig | undefined;
  const accounts = lineConfig?.accounts;
  const ids = new Set<string>();

  if (
    hasConfiguredSecretInput(lineConfig?.channelAccessToken) ||
    lineConfig?.tokenFile ||
    process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim()
  ) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  if (accounts) {
    for (const id of Object.keys(accounts)) {
      ids.add(id);
    }
  }

  return Array.from(ids);
}

export function resolveDefaultLineAccountId(cfg: OpenClawConfig): string {
  const preferred = normalizeOptionalAccountId(
    (cfg.channels?.line as LineConfig | undefined)?.defaultAccount,
  );
  if (
    preferred &&
    listLineAccountIds(cfg).some((accountId) => normalizeSharedAccountId(accountId) === preferred)
  ) {
    return preferred;
  }
  const ids = listLineAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function normalizeAccountId(accountId: string | undefined): string {
  return normalizeSharedAccountId(accountId);
}
