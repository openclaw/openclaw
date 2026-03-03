import {
  hasConfiguredSecretInput,
  promptSingleChannelSecretInput,
  type ChannelOnboardingAdapter,
  type OpenClawConfig,
  type SecretInput,
  type WizardPrompter,
} from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  listMattermostAccountIds,
  resolveDefaultMattermostAccountId,
  resolveMattermostAccount,
} from "./mattermost/accounts.js";
import { promptAccountId } from "./onboarding-helpers.js";

const channel = "mattermost" as const;

async function noteMattermostSetup(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Mattermost System Console -> Integrations -> Bot Accounts",
      "2) Create a bot + copy its token",
      "3) Use your server base URL (e.g., https://chat.example.com)",
      "Tip: the bot must be a member of any channel you want it to monitor.",
      "Docs: https://docs.openclaw.ai/channels/mattermost",
    ].join("\n"),
    "Mattermost bot token",
  );
}

async function promptMattermostBaseUrl(params: {
  prompter: WizardPrompter;
  initialValue?: string;
}): Promise<string> {
  const baseUrl = String(
    await params.prompter.text({
      message: "Enter Mattermost base URL",
      initialValue: params.initialValue,
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
  return baseUrl;
}

export const mattermostOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listMattermostAccountIds(cfg).some((accountId) => {
      const account = resolveMattermostAccount({
        cfg,
        accountId,
        allowUnresolvedSecretRef: true,
      });
      const tokenConfigured =
        Boolean(account.botToken) || hasConfiguredSecretInput(account.config.botToken);
      return tokenConfigured && Boolean(account.baseUrl);
    });
    return {
      channel,
      configured,
      statusLines: [`Mattermost: ${configured ? "configured" : "needs token + url"}`],
      selectionHint: configured ? "configured" : "needs setup",
      quickstartScore: configured ? 2 : 1,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const override = accountOverrides.mattermost?.trim();
    const defaultAccountId = resolveDefaultMattermostAccountId(cfg);
    let accountId = override ? normalizeAccountId(override) : defaultAccountId;
    if (shouldPromptAccountIds && !override) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        label: "Mattermost",
        currentId: accountId,
        listAccountIds: listMattermostAccountIds,
        defaultAccountId,
      });
    }

    let next = cfg;
    const resolvedAccount = resolveMattermostAccount({
      cfg: next,
      accountId,
      allowUnresolvedSecretRef: true,
    });
    const accountConfigured = Boolean(resolvedAccount.botToken && resolvedAccount.baseUrl);
    const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv =
      allowEnv &&
      Boolean(process.env.MATTERMOST_BOT_TOKEN?.trim()) &&
      Boolean(process.env.MATTERMOST_URL?.trim());
    const hasConfigToken = hasConfiguredSecretInput(resolvedAccount.config.botToken);
    const hasConfigValues = hasConfigToken || Boolean(resolvedAccount.config.baseUrl);

    let botToken: SecretInput | null = null;
    let baseUrl: string | null = null;

    if (!accountConfigured) {
      await noteMattermostSetup(prompter);
    }

    const botTokenResult = await promptSingleChannelSecretInput({
      cfg: next,
      prompter,
      providerHint: "mattermost",
      credentialLabel: "bot token",
      accountConfigured,
      canUseEnv: canUseEnv && !hasConfigValues,
      hasConfigToken,
      envPrompt: "MATTERMOST_BOT_TOKEN + MATTERMOST_URL detected. Use env vars?",
      keepPrompt: "Mattermost bot token already configured. Keep it?",
      inputPrompt: "Enter Mattermost bot token",
      preferredEnvVar: "MATTERMOST_BOT_TOKEN",
    });
    if (botTokenResult.action === "keep") {
      return { cfg: next, accountId };
    }

    if (botTokenResult.action === "use-env") {
      if (accountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            mattermost: {
              ...next.channels?.mattermost,
              enabled: true,
            },
          },
        };
      }
      return { cfg: next, accountId };
    }

    botToken = botTokenResult.value;
    baseUrl = await promptMattermostBaseUrl({
      prompter,
      initialValue: resolvedAccount.baseUrl ?? process.env.MATTERMOST_URL?.trim(),
    });

    if (accountId === DEFAULT_ACCOUNT_ID) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          mattermost: {
            ...next.channels?.mattermost,
            enabled: true,
            botToken,
            baseUrl,
          },
        },
      };
    } else {
      next = {
        ...next,
        channels: {
          ...next.channels,
          mattermost: {
            ...next.channels?.mattermost,
            enabled: true,
            accounts: {
              ...next.channels?.mattermost?.accounts,
              [accountId]: {
                ...next.channels?.mattermost?.accounts?.[accountId],
                enabled: next.channels?.mattermost?.accounts?.[accountId]?.enabled ?? true,
                botToken,
                baseUrl,
              },
            },
          },
        },
      };
    }

    return { cfg: next, accountId };
  },
  disable: (cfg: OpenClawConfig) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      mattermost: { ...cfg.channels?.mattermost, enabled: false },
    },
  }),
};
