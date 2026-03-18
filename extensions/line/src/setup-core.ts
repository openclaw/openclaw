import type { ChannelSetupAdapter, OpenClawConfig } from "openclaw/plugin-sdk/setup";
import {
  DEFAULT_ACCOUNT_ID,
  listLineAccountIds,
  normalizeAccountId,
  resolveLineAccount,
  type LineConfig,
} from "../runtime-api.js";

const channel = "line" as const;

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
    for (const field of clearFields) {
      delete nextLine[field];
    }
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        line: {
          ...nextLine,
          ...(params.enabled ? { enabled: true } : {}),
          ...params.patch,
        },
      },
    };
  }

  const nextAccount = {
    ...(lineConfig.accounts?.[accountId] ?? {}),
  } as Record<string, unknown>;
  for (const field of clearFields) {
    delete nextAccount[field];
  }

  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      line: {
        ...lineConfig,
        ...(params.enabled ? { enabled: true } : {}),
        accounts: {
          ...lineConfig.accounts,
          [accountId]: {
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
