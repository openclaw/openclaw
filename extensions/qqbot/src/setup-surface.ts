import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  createStandardChannelSetupStatus,
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
import { getPlatformAdapter } from "./engine/adapter/index.js";
import { clearCredentialField } from "./engine/config/credentials.js";
import { isAccountConfigured } from "./engine/config/resolve.js";
import { normalizeOptionalString } from "./engine/utils/string-normalize.js";

const channel = "qqbot" as const;

function clearQQBotCredentialField(
  cfg: OpenClawConfig,
  accountId: string,
  field: "appId" | "clientSecret",
): OpenClawConfig {
  return clearCredentialField(
    cfg as unknown as Record<string, unknown>,
    accountId,
    field,
  ) as OpenClawConfig;
}

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
    resolveConfigured: ({ cfg, accountId }) =>
      (accountId ? [accountId] : listQQBotAccountIds(cfg)).some((resolvedAccountId) => {
        const account = resolveQQBotAccount(cfg, resolvedAccountId, {
          allowUnresolvedSecretRef: true,
        });
        return isAccountConfigured(account as never);
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
          getPlatformAdapter().hasConfiguredSecret(resolved.config.clientSecret) ||
          normalizeOptionalString(resolved.config.clientSecretFile) ||
          resolved.clientSecret,
        );
        return {
          accountConfigured: Boolean(resolved.appId && hasConfiguredValue),
          hasConfiguredValue: Boolean(resolved.appId),
          resolvedValue: resolved.appId || undefined,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? normalizeOptionalString(process.env.QQBOT_APP_ID)
              : undefined,
        };
      },
      applyUseEnv: ({ cfg, accountId }) =>
        clearQQBotCredentialField(applyQQBotAccountConfig(cfg, accountId, {}), accountId, "appId"),
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
          getPlatformAdapter().hasConfiguredSecret(resolved.config.clientSecret) ||
          normalizeOptionalString(resolved.config.clientSecretFile) ||
          resolved.clientSecret,
        );
        return {
          accountConfigured: Boolean(resolved.appId && hasConfiguredValue),
          hasConfiguredValue,
          resolvedValue: resolved.clientSecret || undefined,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? normalizeOptionalString(process.env.QQBOT_CLIENT_SECRET)
              : undefined,
        };
      },
      applyUseEnv: ({ cfg, accountId }) =>
        clearQQBotCredentialField(
          applyQQBotAccountConfig(cfg, accountId, {}),
          accountId,
          "clientSecret",
        ),
      applySet: ({ cfg, accountId, resolvedValue }) =>
        applyQQBotAccountConfig(cfg, accountId, { clientSecret: resolvedValue }),
    },
  ],
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
