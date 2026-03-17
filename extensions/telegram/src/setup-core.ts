import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  formatCliCommand,
  formatDocsLink,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  patchChannelConfigForAccount,
  promptResolvedAllowFrom,
  splitSetupEntries,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import type { ChannelSetupAdapter, ChannelSetupDmPolicy } from "openclaw/plugin-sdk/setup";
import { resolveDefaultTelegramAccountId, resolveTelegramAccount } from "./accounts.js";
import { fetchTelegramChatId } from "./api-fetch.js";

const channel = "telegram" as const;

export const TELEGRAM_TOKEN_HELP_LINES = [
  "1) Open Telegram and chat with @BotFather",
  "2) Run /newbot (or /mybots)",
  "3) Copy the token (looks like 123456:ABC...)",
  "Tip: you can also set TELEGRAM_BOT_TOKEN in your env.",
  `Docs: ${formatDocsLink("/telegram")}`,
  "Website: https://openclaw.ai",
];

export const TELEGRAM_USER_ID_HELP_LINES = [
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

export async function resolveTelegramAllowFromEntries(params: {
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

export async function promptTelegramAllowFromForAccount(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}) {
  const accountId = params.accountId ?? resolveDefaultTelegramAccountId(params.cfg);
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
    parseInputs: splitSetupEntries,
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
