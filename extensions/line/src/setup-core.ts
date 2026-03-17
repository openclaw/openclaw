import type { ChannelSetupAdapter, OpenClawConfig } from "openclaw/plugin-sdk/setup";
import {
  DEFAULT_ACCOUNT_ID,
  listLineAccountIds,
  normalizeAccountId,
  resolveLineAccount,
  type LineConfig,
} from "../runtime-api.js";

const channel = "line" as const;

function cloneLineAccountEntry(
  lineConfig: LineConfig,
  accountId: string,
): { accountKey: string; entry: Record<string, unknown> } | undefined {
  const accounts = lineConfig.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const accountKey =
    Object.keys(accounts).find((key) => key === accountId || key.toLowerCase() === accountId) ??
    undefined;
  const entry = accountKey ? accounts[accountKey] : undefined;
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  return { accountKey, entry: { ...entry } as Record<string, unknown> };
}

function clearPatchedFields(
  target: Record<string, unknown> | undefined,
  clearFields: string[],
): void {
  if (!target) {
    return;
  }
  for (const field of clearFields) {
    delete target[field];
  }
}

function patchExistingDefaultLineAccount(params: {
  lineConfig: LineConfig;
  clearFields: string[];
  enabled?: boolean;
  patch: Record<string, unknown>;
}): { accountKey: string; entry: Record<string, unknown> } | undefined {
  const nextDefaultAccount = cloneLineAccountEntry(params.lineConfig, DEFAULT_ACCOUNT_ID);
  if (!nextDefaultAccount) {
    return undefined;
  }
  clearPatchedFields(nextDefaultAccount.entry, params.clearFields);
  if (params.enabled) {
    nextDefaultAccount.entry.enabled = true;
  }
  Object.assign(nextDefaultAccount.entry, params.patch);
  return nextDefaultAccount;
}

export function patchLineAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
  clearFields?: string[];
  enabled?: boolean;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  const lineConfig = (params.cfg.channels?.line ?? {}) as LineConfig;
  const clearFields = params.clearFields ?? [];

  if (accountId === DEFAULT_ACCOUNT_ID) {
    const nextLine = { ...lineConfig } as Record<string, unknown>;
    clearPatchedFields(nextLine, clearFields);
    const nextDefaultAccount = patchExistingDefaultLineAccount({
      lineConfig,
      clearFields,
      enabled: params.enabled,
      patch: params.patch,
    });
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        line: {
          ...nextLine,
          ...(params.enabled ? { enabled: true } : {}),
          ...params.patch,
          ...(nextDefaultAccount
            ? {
                accounts: {
                  ...lineConfig.accounts,
                  [nextDefaultAccount.accountKey]: nextDefaultAccount.entry,
                },
              }
            : {}),
        },
      },
    };
  }

  const existingAccount = cloneLineAccountEntry(lineConfig, accountId);
  const nextAccount = existingAccount?.entry ?? ({} as Record<string, unknown>);
  clearPatchedFields(nextAccount, clearFields);
  const accountKey = existingAccount?.accountKey ?? accountId;

  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      line: {
        ...lineConfig,
        ...(params.enabled ? { enabled: true } : {}),
        accounts: {
          ...lineConfig.accounts,
          [accountKey]: {
            ...nextAccount,
            ...(params.enabled ? { enabled: true } : {}),
            ...params.patch,
          },
        },
      },
    },
  };
}

export function isLineConfigured(cfg: OpenClawConfig, accountId: string): boolean {
  const resolved = resolveLineAccount({ cfg, accountId });
  return Boolean(resolved.channelAccessToken.trim() && resolved.channelSecret.trim());
}

export function parseLineAllowFromId(raw: string): string | null {
  const trimmed = raw.trim().replace(/^line:(?:user:)?/i, "");
  if (!/^U[a-f0-9]{32}$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export const lineSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    patchLineAccountConfig({
      cfg,
      accountId,
      patch: name?.trim() ? { name: name.trim() } : {},
    }),
  validateInput: ({ accountId, input }) => {
    const typedInput = input as {
      useEnv?: boolean;
      channelAccessToken?: string;
      channelSecret?: string;
      tokenFile?: string;
      secretFile?: string;
    };
    if (typedInput.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      return "LINE_CHANNEL_ACCESS_TOKEN can only be used for the default account.";
    }
    if (!typedInput.useEnv && !typedInput.channelAccessToken && !typedInput.tokenFile) {
      return "LINE requires channelAccessToken or --token-file (or --use-env).";
    }
    if (!typedInput.useEnv && !typedInput.channelSecret && !typedInput.secretFile) {
      return "LINE requires channelSecret or --secret-file (or --use-env).";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const typedInput = input as {
      useEnv?: boolean;
      channelAccessToken?: string;
      channelSecret?: string;
      tokenFile?: string;
      secretFile?: string;
    };
    const normalizedAccountId = normalizeAccountId(accountId);
    if (normalizedAccountId === DEFAULT_ACCOUNT_ID) {
      return patchLineAccountConfig({
        cfg,
        accountId: normalizedAccountId,
        enabled: true,
        clearFields: typedInput.useEnv
          ? ["channelAccessToken", "channelSecret", "tokenFile", "secretFile"]
          : undefined,
        patch: typedInput.useEnv
          ? {}
          : {
              ...(typedInput.tokenFile
                ? { tokenFile: typedInput.tokenFile }
                : typedInput.channelAccessToken
                  ? { channelAccessToken: typedInput.channelAccessToken }
                  : {}),
              ...(typedInput.secretFile
                ? { secretFile: typedInput.secretFile }
                : typedInput.channelSecret
                  ? { channelSecret: typedInput.channelSecret }
                  : {}),
            },
      });
    }
    return patchLineAccountConfig({
      cfg,
      accountId: normalizedAccountId,
      enabled: true,
      patch: {
        ...(typedInput.tokenFile
          ? { tokenFile: typedInput.tokenFile }
          : typedInput.channelAccessToken
            ? { channelAccessToken: typedInput.channelAccessToken }
            : {}),
        ...(typedInput.secretFile
          ? { secretFile: typedInput.secretFile }
          : typedInput.channelSecret
            ? { channelSecret: typedInput.channelSecret }
            : {}),
      },
    });
  },
};

export { listLineAccountIds };
