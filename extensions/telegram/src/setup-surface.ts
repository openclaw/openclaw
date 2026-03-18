import {
  createAllowFromSection,
  DEFAULT_ACCOUNT_ID,
  hasConfiguredSecretInput,
  type OpenClawConfig,
  patchChannelConfigForAccount,
  setChannelDmPolicyWithAllowFrom,
  setSetupChannelEnabled,
  splitSetupEntries,
} from "openclaw/plugin-sdk/setup";
import type { ChannelSetupDmPolicy, ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { inspectTelegramAccount } from "./account-inspect.js";
import { listTelegramAccountIds, resolveTelegramAccount } from "./accounts.js";
import {
  parseTelegramAllowFromId,
  promptTelegramAllowFromForAccount,
  resolveTelegramAllowFromEntries,
  TELEGRAM_TOKEN_HELP_LINES,
  TELEGRAM_USER_ID_HELP_LINES,
  telegramSetupAdapter,
} from "./setup-core.js";

const channel = "telegram" as const;

const dmPolicy: ChannelSetupDmPolicy = {
  label: "Telegram",
  channel,
  policyKey: "channels.telegram.dmPolicy",
  allowFromKey: "channels.telegram.allowFrom",
  getCurrent: (cfg) => cfg.channels?.telegram?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) =>
    setChannelDmPolicyWithAllowFrom({
      cfg,
      channel,
      dmPolicy: policy,
    }),
  promptAllowFrom: promptTelegramAllowFromForAccount,
};

export const telegramSetupWizard: ChannelSetupWizard = {
  channel,
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs token",
    configuredHint: "recommended · configured",
    unconfiguredHint: "recommended · newcomer-friendly",
    configuredScore: 1,
    unconfiguredScore: 10,
    resolveConfigured: ({ cfg }) =>
      listTelegramAccountIds(cfg).some((accountId) => {
        const account = inspectTelegramAccount({ cfg, accountId });
        return account.configured;
      }),
  },
  credentials: [
    {
      inputKey: "token",
      providerHint: channel,
      credentialLabel: "Telegram bot token",
      preferredEnvVar: "TELEGRAM_BOT_TOKEN",
      helpTitle: "Telegram bot token",
      helpLines: TELEGRAM_TOKEN_HELP_LINES,
      envPrompt: "TELEGRAM_BOT_TOKEN detected. Use env var?",
      keepPrompt: "Telegram token already configured. Keep it?",
      inputPrompt: "Enter Telegram bot token",
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      inspect: ({ cfg, accountId }) => {
        const resolved = resolveTelegramAccount({ cfg, accountId });
        const hasConfiguredBotToken = hasConfiguredSecretInput(resolved.config.botToken);
        const hasConfiguredValue =
          hasConfiguredBotToken || Boolean(resolved.config.tokenFile?.trim());
        return {
          accountConfigured: Boolean(resolved.token) || hasConfiguredValue,
          hasConfiguredValue,
          resolvedValue: resolved.token?.trim() || undefined,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined
              : undefined,
        };
      },
    },
  ],
  allowFrom: createAllowFromSection({
    helpTitle: "Telegram user id",
    helpLines: TELEGRAM_USER_ID_HELP_LINES,
    credentialInputKey: "token",
    message: "Telegram allowFrom (numeric sender id; @username resolves to id)",
    placeholder: "@username",
    invalidWithoutCredentialNote:
      "Telegram token missing; use numeric sender ids (usernames require a bot token).",
    parseInputs: splitSetupEntries,
    parseId: parseTelegramAllowFromId,
    resolveEntries: async ({ credentialValues, entries }) =>
      resolveTelegramAllowFromEntries({
        credentialValue: credentialValues.token,
        entries,
      }),
    apply: async ({ cfg, accountId, allowFrom }) =>
      patchChannelConfigForAccount({
        cfg,
        channel,
        accountId,
        patch: { dmPolicy: "allowlist", allowFrom },
      }),
  }),
  dmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};

export { parseTelegramAllowFromId, telegramSetupAdapter };
