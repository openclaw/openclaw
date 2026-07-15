// ClickClack plugin module implements non-interactive setup behavior.
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  migrateBaseNameToDefaultAccount,
} from "openclaw/plugin-sdk/setup";
import { createSetupInputPresenceValidator } from "openclaw/plugin-sdk/setup-runtime";
import { resolveClickClackAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";

const channel = "clickclack" as const;
const REQUIRED_INPUT_ERROR =
  "ClickClack requires --token, --base-url, and --workspace (or --use-env).";

export function normalizeClickClackBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

export function applyClickClackSetupConfigPatch(params: {
  cfg: OpenClawConfig;
  accountId: string;
  name?: string;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  const namedConfig = applyAccountNameToChannelSection({
    cfg: params.cfg,
    channelKey: channel,
    accountId: params.accountId,
    name: params.name,
  });
  const next =
    params.accountId !== DEFAULT_ACCOUNT_ID
      ? migrateBaseNameToDefaultAccount({
          cfg: namedConfig,
          channelKey: channel,
        })
      : namedConfig;
  return applySetupAccountConfigPatch({
    cfg: next,
    channelKey: channel,
    accountId: params.accountId,
    patch: params.patch,
  });
}

function clearClickClackSetupConfigFields(params: {
  cfg: OpenClawConfig;
  accountId: string;
  fields: string[];
}): OpenClawConfig {
  const clickclack = (params.cfg.channels as Record<string, unknown> | undefined)?.clickclack as
    | (Record<string, unknown> & { accounts?: Record<string, Record<string, unknown>> })
    | undefined;
  if (!clickclack) {
    return params.cfg;
  }
  const accountId = normalizeAccountId(params.accountId);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const nextClickClack = { ...clickclack };
    for (const field of params.fields) {
      delete nextClickClack[field];
    }
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        clickclack: nextClickClack,
      },
    } as OpenClawConfig;
  }
  const currentAccount = clickclack.accounts?.[accountId];
  if (!currentAccount) {
    return params.cfg;
  }
  const nextAccount = { ...currentAccount };
  for (const field of params.fields) {
    delete nextAccount[field];
  }
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      clickclack: {
        ...clickclack,
        accounts: {
          ...clickclack.accounts,
          [accountId]: nextAccount,
        },
      },
    },
  } as OpenClawConfig;
}

export function applyClickClackCredentialConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  token?: unknown;
  tokenFile?: string;
  useEnv?: boolean;
}): OpenClawConfig {
  const fieldsToClear = params.useEnv
    ? ["token", "tokenFile"]
    : params.tokenFile
      ? ["token"]
      : params.token !== undefined
        ? ["tokenFile"]
        : [];
  const next = applyClickClackSetupConfigPatch({
    cfg: params.cfg,
    accountId: params.accountId,
    patch: params.useEnv
      ? {}
      : params.tokenFile
        ? { tokenFile: params.tokenFile }
        : params.token !== undefined
          ? { token: params.token }
          : {},
  });
  return clearClickClackSetupConfigFields({
    cfg: next,
    accountId: params.accountId,
    fields: fieldsToClear,
  });
}

export const clickClackSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name,
    }),
  validateInput: createSetupInputPresenceValidator({
    defaultAccountOnlyEnvError: "CLICKCLACK_BOT_TOKEN can only be used for the default account.",
    whenNotUseEnv: [
      { someOf: ["token", "tokenFile"], message: REQUIRED_INPUT_ERROR },
      { someOf: ["baseUrl"], message: REQUIRED_INPUT_ERROR },
      { someOf: ["workspace"], message: REQUIRED_INPUT_ERROR },
    ],
    validate: ({ cfg, accountId, input }) => {
      const baseUrl = normalizeClickClackBaseUrl(input.baseUrl);
      if (input.baseUrl && !baseUrl) {
        return "ClickClack --base-url must be a valid http(s) URL.";
      }
      if (!input.useEnv) {
        return null;
      }
      const resolved = resolveClickClackAccount({
        cfg: cfg as CoreConfig,
        accountId,
      });
      if (!baseUrl && !resolved.baseUrl) {
        return REQUIRED_INPUT_ERROR;
      }
      if (!input.workspace?.trim() && !resolved.workspace) {
        return REQUIRED_INPUT_ERROR;
      }
      return null;
    },
  }),
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const baseUrl = normalizeClickClackBaseUrl(input.baseUrl);
    const workspace = input.workspace?.trim();
    const tokenFile = input.tokenFile?.trim();
    const token = input.token?.trim();
    const next = applyClickClackSetupConfigPatch({
      cfg,
      accountId,
      name: input.name,
      patch: {
        ...(baseUrl ? { baseUrl } : {}),
        ...(workspace ? { workspace } : {}),
      },
    });
    return applyClickClackCredentialConfig({
      cfg: next,
      accountId,
      token,
      tokenFile,
      useEnv: input.useEnv,
    });
  },
};
