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
    return applyClickClackSetupConfigPatch({
      cfg,
      accountId,
      name: input.name,
      patch: {
        ...(baseUrl ? { baseUrl } : {}),
        ...(workspace ? { workspace } : {}),
        ...(!input.useEnv && tokenFile ? { tokenFile } : !input.useEnv && token ? { token } : {}),
      },
    });
  },
};
