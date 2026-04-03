import {
  addWildcardAllowFrom,
  createAllowFromSection,
  createStandardChannelSetupStatus,
  type ChannelSetupDmPolicy,
  DEFAULT_ACCOUNT_ID,
  hasConfiguredSecretInput,
  type OpenClawConfig,
  patchChannelConfigForAccount,
  setSetupChannelEnabled,
  splitSetupEntries,
} from "openclaw/plugin-sdk/setup";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { formatCliCommand, formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { inspectTelegramAccount } from "./account-inspect.js";
import {
  listTelegramAccountIds,
  mergeTelegramAccountConfig,
  resolveTelegramAccount,
} from "./accounts.js";
import {
  parseTelegramAllowFromId,
  promptTelegramAllowFromForAccount,
  resolveTelegramAllowFromEntries,
  TELEGRAM_TOKEN_HELP_LINES,
  TELEGRAM_USER_ID_HELP_LINES,
  telegramSetupAdapter,
} from "./setup-core.js";

const channel = "telegram" as const;

function ensureTelegramDefaultGroupMentionGate(
  cfg: OpenClawConfig,
  accountId: string,
): OpenClawConfig {
  const resolved = resolveTelegramAccount({ cfg, accountId });
  const wildcardGroup = resolved.config.groups?.["*"];
  if (wildcardGroup?.requireMention !== undefined) {
    return cfg;
  }
  return patchChannelConfigForAccount({
    cfg,
    channel,
    accountId,
    patch: {
      groups: {
        ...resolved.config.groups,
        "*": {
          ...wildcardGroup,
          requireMention: true,
        },
      },
    },
  });
}

function shouldShowTelegramDmAccessWarning(cfg: OpenClawConfig, accountId: string): boolean {
  const merged = mergeTelegramAccountConfig(cfg, accountId);
  const policy = merged.dmPolicy ?? "pairing";
  const hasAllowFrom =
    Array.isArray(merged.allowFrom) && merged.allowFrom.some((e) => String(e).trim());
  return policy === "pairing" && !hasAllowFrom;
}

function buildTelegramDmAccessWarningLines(accountId: string): string[] {
  const configBase =
    accountId === DEFAULT_ACCOUNT_ID
      ? "channels.telegram"
      : `channels.telegram.accounts.${accountId}`;
  return [
    "Your bot is using DM policy: pairing.",
    "Any Telegram user who discovers the bot can send pairing requests.",
    "For private use, configure an allowlist with your Telegram user id:",
    "  " + formatCliCommand(`openclaw config set ${configBase}.dmPolicy "allowlist"`),
    "  " + formatCliCommand(`openclaw config set ${configBase}.allowFrom '["YOUR_USER_ID"]'`),
    `Docs: ${formatDocsLink("/channels/pairing", "channels/pairing")}`,
  ];
}

const dmPolicy: ChannelSetupDmPolicy = {
  label: "Telegram",
  channel,
  policyKey: "channels.telegram.dmPolicy",
  allowFromKey: "channels.telegram.allowFrom",
  resolveConfigKeys: (_cfg, accountId) =>
    accountId && accountId !== DEFAULT_ACCOUNT_ID
      ? {
          policyKey: `channels.telegram.accounts.${accountId}.dmPolicy`,
          allowFromKey: `channels.telegram.accounts.${accountId}.allowFrom`,
        }
      : {
          policyKey: "channels.telegram.dmPolicy",
          allowFromKey: "channels.telegram.allowFrom",
        },
  getCurrent: (cfg, accountId) =>
    mergeTelegramAccountConfig(cfg, accountId ?? DEFAULT_ACCOUNT_ID).dmPolicy ?? "pairing",
  setPolicy: (cfg, policy, accountId) => {
    const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
    const merged = mergeTelegramAccountConfig(cfg, resolvedAccountId);
    return patchChannelConfigForAccount({
      cfg,
      channel,
      accountId: resolvedAccountId,
      patch: {
        dmPolicy: policy,
        ...(policy === "open" ? { allowFrom: addWildcardAllowFrom(merged.allowFrom) } : {}),
      },
    });
  },
  promptAllowFrom: promptTelegramAllowFromForAccount,
};

export const telegramSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "Telegram",
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
  }),
  prepare: async ({ cfg, accountId, credentialValues }) => ({
    cfg: ensureTelegramDefaultGroupMentionGate(cfg, accountId),
    credentialValues,
  }),
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
    resolveEntries: async ({ cfg, accountId, credentialValues, entries }) =>
      resolveTelegramAllowFromEntries({
        credentialValue: credentialValues.token,
        entries,
        apiRoot: resolveTelegramAccount({ cfg, accountId }).config.apiRoot,
      }),
    apply: async ({ cfg, accountId, allowFrom }) =>
      patchChannelConfigForAccount({
        cfg,
        channel,
        accountId,
        patch: { dmPolicy: "allowlist", allowFrom },
      }),
  }),
  finalize: async ({ cfg, accountId, prompter }) => {
    if (!shouldShowTelegramDmAccessWarning(cfg, accountId)) {
      return;
    }
    await prompter.note(
      buildTelegramDmAccessWarningLines(accountId).join("\n"),
      "Telegram DM access warning",
    );
  },
  dmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};

export { parseTelegramAllowFromId, telegramSetupAdapter };
