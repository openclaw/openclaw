import {
  type ChannelOnboardingAdapter,
  type ChannelOnboardingDmPolicy,
} from "../../../src/channels/plugins/onboarding-types.js";
import {
  patchChannelConfigForAccount,
  promptResolvedAllowFrom,
  resolveOnboardingAccountId,
  setChannelDmPolicyWithAllowFrom,
  setOnboardingChannelEnabled,
  splitOnboardingEntries,
} from "../../../src/channels/plugins/onboarding/helpers.js";
import {
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "../../../src/channels/plugins/setup-helpers.js";
import {
  buildChannelOnboardingAdapterFromSetupWizard,
  type ChannelSetupWizard,
} from "../../../src/channels/plugins/setup-wizard.js";
import type { ChannelSetupAdapter } from "../../../src/channels/plugins/types.adapters.js";
import { getChatChannelMeta } from "../../../src/channels/registry.js";
import { formatCliCommand } from "../../../src/cli/command-format.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { hasConfiguredSecretInput } from "../../../src/config/types.secrets.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../src/routing/session-key.js";
import { formatDocsLink } from "../../../src/terminal/links.js";
import { inspectTelegramAccount } from "./account-inspect.js";
import {
  listTelegramAccountIds,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
} from "./accounts.js";
import { fetchTelegramChatId } from "./api-fetch.js";

const channel = "telegram" as const;

const TELEGRAM_TOKEN_HELP_LINES = [
  "1) Open Telegram and chat with @BotFather",
  "2) Run /newbot (or /mybots)",
  "3) Copy the token (looks like 123456:ABC...)",
  "Tip: you can also set TELEGRAM_BOT_TOKEN in your env.",
  `Docs: ${formatDocsLink("/telegram")}`,
  "Website: https://openclaw.ai",
];

const TELEGRAM_USER_ID_HELP_LINES = [
  `1) DM your bot, then read from.id in \`${formatCliCommand("openclaw logs --follow")}\` (safest)`,
  "2) Or call https://api.telegram.org/bot<bot_token>/getUpdates and read message.from.id",
  "3) Third-party: DM @userinfobot or @getidsbot",
  `Docs: ${formatDocsLink("/telegram")}`,
  "Website: https://openclaw.ai",
];

export function normalizeTelegramAllowFromInput(raw: string): string {
  return raw
    .trim()
    .replace(/^(telegram|tg):/i, "")
    .trim();
}

export function parseTelegramAllowFromId(raw: string): string | null {
  const stripped = normalizeTelegramAllowFromInput(raw);
  return /^\d+$/.test(stripped) ? stripped : null;
}

async function resolveTelegramAllowFromEntries(params: {
  entries: string[];
  credentialValue?: string;
}) {
  return await Promise.all(
    params.entries.map(async (entry) => {
      const numericId = parseTelegramAllowFromId(entry);
      if (numericId) {
        return { input: entry, resolved: true, id: numericId };
      }
      const stripped = normalizeTelegramAllowFromInput(entry);
      if (!stripped || !params.credentialValue?.trim()) {
        return { input: entry, resolved: false, id: null };
      }
      const username = stripped.startsWith("@") ? stripped : `@${stripped}`;
      const id = await fetchTelegramChatId({
        token: params.credentialValue,
        chatId: username,
      });
      return { input: entry, resolved: Boolean(id), id };
    }),
  );
}

async function promptTelegramAllowFromForAccount(params: {
  cfg: OpenClawConfig;
  prompter: Parameters<NonNullable<ChannelOnboardingDmPolicy["promptAllowFrom"]>>[0]["prompter"];
  accountId?: string;
}): Promise<OpenClawConfig> {
  const accountId = resolveOnboardingAccountId({
    accountId: params.accountId,
    defaultAccountId: resolveDefaultTelegramAccountId(params.cfg),
  });
  const resolved = resolveTelegramAccount({ cfg: params.cfg, accountId });
  await params.prompter.note(TELEGRAM_USER_ID_HELP_LINES.join("\n"), "Telegram user id");
  if (!resolved.token?.trim()) {
    await params.prompter.note(
      "Telegram token missing; username lookup is unavailable.",
      "Telegram",
    );
  }
  const unique = await promptResolvedAllowFrom({
    prompter: params.prompter,
    existing: resolved.config.allowFrom ?? [],
    token: resolved.token,
    message: "Telegram allowFrom (numeric sender id; @username resolves to id)",
    placeholder: "@username",
    label: "Telegram allowlist",
    parseInputs: splitOnboardingEntries,
    parseId: parseTelegramAllowFromId,
    invalidWithoutTokenNote:
      "Telegram token missing; use numeric sender ids (usernames require a bot token).",
    resolveEntries: async ({ entries, token }) =>
      resolveTelegramAllowFromEntries({
        credentialValue: token,
        entries,
      }),
  });
  return patchChannelConfigForAccount({
    cfg: params.cfg,
    channel,
    accountId,
    patch: { dmPolicy: "allowlist", allowFrom: unique },
  });
}

const dmPolicy: ChannelOnboardingDmPolicy = {
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

export const telegramSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name,
    }),
  validateInput: ({ accountId, input }) => {
    if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      return "TELEGRAM_BOT_TOKEN can only be used for the default account.";
    }
    if (!input.useEnv && !input.token && !input.tokenFile) {
      return "Telegram requires token or --token-file (or --use-env).";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name: input.name,
    });
    const next =
      accountId !== DEFAULT_ACCOUNT_ID
        ? migrateBaseNameToDefaultAccount({
            cfg: namedConfig,
            channelKey: channel,
          })
        : namedConfig;
    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...next,
        channels: {
          ...next.channels,
          telegram: {
            ...next.channels?.telegram,
            enabled: true,
            ...(input.useEnv
              ? {}
              : input.tokenFile
                ? { tokenFile: input.tokenFile }
                : input.token
                  ? { botToken: input.token }
                  : {}),
          },
        },
      };
    }
    return {
      ...next,
      channels: {
        ...next.channels,
        telegram: {
          ...next.channels?.telegram,
          enabled: true,
          accounts: {
            ...next.channels?.telegram?.accounts,
            [accountId]: {
              ...next.channels?.telegram?.accounts?.[accountId],
              enabled: true,
              ...(input.tokenFile
                ? { tokenFile: input.tokenFile }
                : input.token
                  ? { botToken: input.token }
                  : {}),
            },
          },
        },
      },
    };
  },
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
  credential: {
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
  allowFrom: {
    helpTitle: "Telegram user id",
    helpLines: TELEGRAM_USER_ID_HELP_LINES,
    message: "Telegram allowFrom (numeric sender id; @username resolves to id)",
    placeholder: "@username",
    invalidWithoutCredentialNote:
      "Telegram token missing; use numeric sender ids (usernames require a bot token).",
    parseInputs: splitOnboardingEntries,
    parseId: parseTelegramAllowFromId,
    resolveEntries: async ({ credentialValue, entries }) =>
      resolveTelegramAllowFromEntries({
        credentialValue,
        entries,
      }),
    apply: async ({ cfg, accountId, allowFrom }) =>
      patchChannelConfigForAccount({
        cfg,
        channel,
        accountId,
        patch: { dmPolicy: "allowlist", allowFrom },
      }),
  },
  dmPolicy,
  disable: (cfg) => setOnboardingChannelEnabled(cfg, channel, false),
};

const telegramSetupPlugin = {
  id: channel,
  meta: {
    ...getChatChannelMeta(channel),
    quickstartAllowFrom: true,
  },
  config: {
    listAccountIds: listTelegramAccountIds,
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
      resolveTelegramAccount({ cfg, accountId }),
    resolveAllowFrom: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) =>
      resolveTelegramAccount({ cfg, accountId }).config.allowFrom,
  },
  setup: telegramSetupAdapter,
} as const;

export const telegramOnboardingAdapter: ChannelOnboardingAdapter =
  buildChannelOnboardingAdapterFromSetupWizard({
    plugin: telegramSetupPlugin,
    wizard: telegramSetupWizard,
  });
