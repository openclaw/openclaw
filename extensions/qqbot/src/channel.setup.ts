import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  applyAccountNameToChannelSection,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk/core";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";
import type { ChannelSetupInput } from "openclaw/plugin-sdk/setup";
import { qqbotChannelConfigSchema } from "./config-schema.js";
import {
  DEFAULT_ACCOUNT_ID,
  listQQBotAccountIds,
  resolveQQBotAccount,
  applyQQBotAccountConfig,
  resolveDefaultQQBotAccountId,
} from "./config.js";
import { qqbotSetupWizard } from "./setup-surface.js";
import type { ResolvedQQBotAccount } from "./types.js";

function parseQQBotInlineToken(token: string): { appId: string; clientSecret: string } | null {
  const colonIdx = token.indexOf(":");
  if (colonIdx <= 0 || colonIdx === token.length - 1) {
    return null;
  }

  const appId = token.slice(0, colonIdx).trim();
  const clientSecret = token.slice(colonIdx + 1).trim();
  if (!appId || !clientSecret) {
    return null;
  }

  return { appId, clientSecret };
}

export function validateQQBotSetupInput(params: {
  accountId: string;
  input: ChannelSetupInput;
}): string | null {
  const { accountId, input } = params;

  if (!input.token && !input.tokenFile && !input.useEnv) {
    return "QQBot requires --token (format: appId:clientSecret) or --use-env";
  }

  if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
    return "QQBot --use-env only supports the default account";
  }

  if (input.token && !parseQQBotInlineToken(input.token)) {
    return "QQBot --token must be in appId:clientSecret format";
  }

  return null;
}

export function applyQQBotSetupAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: ChannelSetupInput;
}): OpenClawConfig {
  if (params.input.useEnv && params.accountId !== DEFAULT_ACCOUNT_ID) {
    return params.cfg;
  }

  let appId = "";
  let clientSecret = "";

  if (params.input.token) {
    const parsed = parseQQBotInlineToken(params.input.token);
    if (!parsed) {
      return params.cfg;
    }
    appId = parsed.appId;
    clientSecret = parsed.clientSecret;
  }

  if (!appId && !params.input.tokenFile && !params.input.useEnv) {
    return params.cfg;
  }

  // When only --token-file is provided, appId will be empty here.
  // This is by design: --token-file supplies the clientSecret only,
  // not the appId. The appId is expected to come from the env var
  // QQBOT_APP_ID or be set separately in the config file.
  return applyQQBotAccountConfig(params.cfg, params.accountId, {
    appId,
    clientSecret,
    clientSecretFile: params.input.tokenFile,
    name: params.input.name,
  });
}

/**
 * Setup-only QQBot plugin — lightweight subset used during `openclaw onboard`
 * and `openclaw configure` without pulling the full runtime dependencies.
 */
export const qqbotSetupPlugin: ChannelPlugin<ResolvedQQBotAccount> = {
  id: "qqbot",
  setupWizard: qqbotSetupWizard,
  meta: {
    id: "qqbot",
    label: "QQ Bot",
    selectionLabel: "QQ Bot",
    docsPath: "/channels/qqbot",
    blurb: "Connect to QQ via official QQ Bot API",
    order: 50,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.qqbot"] },
  configSchema: qqbotChannelConfigSchema,
  config: {
    listAccountIds: (cfg) => listQQBotAccountIds(cfg),
    resolveAccount: (cfg, accountId) =>
      resolveQQBotAccount(cfg, accountId, { allowUnresolvedSecretRef: true }),
    defaultAccountId: (cfg) => resolveDefaultQQBotAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "qqbot",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "qqbot",
        accountId,
        clearBaseFields: ["appId", "clientSecret", "clientSecretFile", "name"],
      }),
    isConfigured: (account) =>
      Boolean(
        account?.appId &&
        (Boolean(account?.clientSecret) ||
          hasConfiguredSecretInput(account?.config?.clientSecret) ||
          Boolean(account?.config?.clientSecretFile?.trim())),
      ),
    describeAccount: (account) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(
        account?.appId &&
        (Boolean(account?.clientSecret) ||
          hasConfiguredSecretInput(account?.config?.clientSecret) ||
          Boolean(account?.config?.clientSecretFile?.trim())),
      ),
      tokenSource: account?.secretSource,
    }),
  },
  setup: {
    resolveAccountId: ({ accountId }) => accountId?.trim().toLowerCase() || DEFAULT_ACCOUNT_ID,
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "qqbot",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => validateQQBotSetupInput({ accountId, input }),
    applyAccountConfig: ({ cfg, accountId, input }) =>
      applyQQBotSetupAccountConfig({ cfg, accountId, input }),
  },
};
