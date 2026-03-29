import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  applyAccountNameToChannelSection,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk/core";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";
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
    validateInput: ({ input }) => {
      if (!input.token && !input.tokenFile && !input.useEnv) {
        return "QQBot requires --token (format: appId:clientSecret) or --use-env";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      let appId = "";
      let clientSecret = "";

      if (input.token) {
        const colonIdx = input.token.indexOf(":");
        if (colonIdx > 0) {
          appId = input.token.slice(0, colonIdx);
          clientSecret = input.token.slice(colonIdx + 1);
        } else {
          // Token must be in appId:clientSecret format; skip config write if malformed.
          return cfg;
        }
      }

      if (!appId && !input.tokenFile) {
        // No valid credentials provided; skip config write.
        return cfg;
      }

      // When only --token-file is provided, appId will be empty here.
      // This is by design: --token-file supplies the clientSecret only,
      // not the appId. The appId is expected to come from the env var
      // QQBOT_APP_ID or be set separately in the config file.
      return applyQQBotAccountConfig(cfg, accountId, {
        appId,
        clientSecret,
        clientSecretFile: input.tokenFile,
        name: input.name,
      });
    },
  },
};
