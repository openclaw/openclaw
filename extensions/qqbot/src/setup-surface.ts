import {
  createStandardChannelSetupStatus,
  hasConfiguredSecretInput,
  setSetupChannelEnabled,
} from "openclaw/plugin-sdk/setup";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import {
  DEFAULT_ACCOUNT_ID,
  listQQBotAccountIds,
  resolveQQBotAccount,
  applyQQBotAccountConfig,
} from "./config.js";

const channel = "qqbot" as const;

const QQBOT_SETUP_HELP_LINES = [
  "To create a QQ Bot, visit the QQ Open Platform:",
  `  ${formatDocsLink("https://q.qq.com", "q.qq.com")}`,
  "",
  "1. Create an application and note the AppID.",
  "2. Go to development settings to find the AppSecret.",
];

export const qqbotSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "QQ Bot",
    configuredLabel: "configured",
    unconfiguredLabel: "needs AppID + AppSecret",
    configuredHint: "configured",
    unconfiguredHint: "needs AppID + AppSecret",
    configuredScore: 1,
    unconfiguredScore: 6,
    resolveConfigured: ({ cfg }) =>
      listQQBotAccountIds(cfg).some((accountId) => {
        const account = resolveQQBotAccount(cfg, accountId, { allowUnresolvedSecretRef: true });
        return Boolean(
          account.appId &&
          (Boolean(account.clientSecret) ||
            hasConfiguredSecretInput(account.config.clientSecret) ||
            Boolean(account.config.clientSecretFile?.trim())),
        );
      }),
  }),
  credentials: [
    {
      inputKey: "token",
      providerHint: channel,
      credentialLabel: "AppID",
      preferredEnvVar: "QQBOT_APP_ID",
      helpTitle: "QQ Bot AppID",
      helpLines: QQBOT_SETUP_HELP_LINES,
      envPrompt: "QQBOT_APP_ID detected. Use env var?",
      keepPrompt: "QQ Bot AppID already configured. Keep it?",
      inputPrompt: "Enter QQ Bot AppID",
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      inspect: ({ cfg, accountId }) => {
        const resolved = resolveQQBotAccount(cfg, accountId, { allowUnresolvedSecretRef: true });
        const hasConfiguredValue = Boolean(
          hasConfiguredSecretInput(resolved.config.clientSecret) ||
          resolved.config.clientSecretFile?.trim() ||
          resolved.clientSecret,
        );
        return {
          accountConfigured: Boolean(resolved.appId && hasConfiguredValue),
          hasConfiguredValue: Boolean(resolved.appId),
          resolvedValue: resolved.appId || undefined,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? process.env.QQBOT_APP_ID?.trim() || undefined
              : undefined,
        };
      },
      applyUseEnv: ({ cfg, accountId }) => applyQQBotAccountConfig(cfg, accountId, {}),
      applySet: ({ cfg, accountId, resolvedValue }) =>
        applyQQBotAccountConfig(cfg, accountId, { appId: resolvedValue }),
    },
    {
      inputKey: "password",
      providerHint: "qqbot-secret",
      credentialLabel: "AppSecret",
      preferredEnvVar: "QQBOT_CLIENT_SECRET",
      helpTitle: "QQ Bot AppSecret",
      helpLines: QQBOT_SETUP_HELP_LINES,
      envPrompt: "QQBOT_CLIENT_SECRET detected. Use env var?",
      keepPrompt: "QQ Bot AppSecret already configured. Keep it?",
      inputPrompt: "Enter QQ Bot AppSecret",
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      inspect: ({ cfg, accountId }) => {
        const resolved = resolveQQBotAccount(cfg, accountId, { allowUnresolvedSecretRef: true });
        const hasConfiguredValue = Boolean(
          hasConfiguredSecretInput(resolved.config.clientSecret) ||
          resolved.config.clientSecretFile?.trim() ||
          resolved.clientSecret,
        );
        return {
          accountConfigured: Boolean(resolved.appId && hasConfiguredValue),
          hasConfiguredValue,
          resolvedValue: resolved.clientSecret || undefined,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? process.env.QQBOT_CLIENT_SECRET?.trim() || undefined
              : undefined,
        };
      },
      applyUseEnv: ({ cfg, accountId }) => applyQQBotAccountConfig(cfg, accountId, {}),
      applySet: ({ cfg, accountId, resolvedValue }) =>
        applyQQBotAccountConfig(cfg, accountId, { clientSecret: resolvedValue }),
    },
  ],
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
