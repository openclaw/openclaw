import type { ChannelOnboardingAdapter, OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk";
import { promptAccountId } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  listPumbleAccountIds,
  resolveDefaultPumbleAccountId,
  resolvePumbleAccount,
} from "./pumble/accounts.js";
import { applyPumbleCredentials } from "./pumble/config-helpers.js";

const channel = "pumble" as const;

async function notePumbleSetup(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Create a Pumble app in the Pumble developer console",
      "2) Copy App ID, App Key, Client Secret, and Signing Secret",
      "3) Complete the OAuth flow to install the app into your workspace",
      "4) Copy botId from tokens.json and set as botUserId in config",
      "Tip: the bot must be invited to any channel you want it to monitor.",
      "Docs: https://docs.openclaw.ai/channels/pumble",
    ].join("\n"),
    "Pumble app credentials",
  );
}

async function promptPumbleCredentials(prompter: WizardPrompter): Promise<{
  appId: string;
  appKey: string;
  clientSecret: string;
  signingSecret: string;
}> {
  const appId = String(
    await prompter.text({
      message: "Enter Pumble App ID",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
  const appKey = String(
    await prompter.text({
      message: "Enter Pumble App Key",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
  const clientSecret = String(
    await prompter.text({
      message: "Enter Pumble Client Secret",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
  const signingSecret = String(
    await prompter.text({
      message: "Enter Pumble Signing Secret",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
  return { appId, appKey, clientSecret, signingSecret };
}

export const pumbleOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listPumbleAccountIds(cfg).some((accountId) => {
      const account = resolvePumbleAccount({ cfg, accountId });
      return Boolean(account.appId && account.appKey);
    });
    return {
      channel,
      configured,
      statusLines: [`Pumble: ${configured ? "configured" : "needs app credentials"}`],
      selectionHint: configured ? "configured" : "needs setup",
      quickstartScore: configured ? 2 : 1,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const override = accountOverrides.pumble?.trim();
    const defaultAccountId = resolveDefaultPumbleAccountId(cfg);
    let accountId = override ? normalizeAccountId(override) : defaultAccountId;
    if (shouldPromptAccountIds && !override) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        label: "Pumble",
        currentId: accountId,
        listAccountIds: listPumbleAccountIds,
        defaultAccountId,
      });
    }

    let next = cfg;
    const resolvedAccount = resolvePumbleAccount({
      cfg: next,
      accountId,
    });
    const accountConfigured = Boolean(resolvedAccount.appId && resolvedAccount.appKey);
    const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv =
      allowEnv &&
      Boolean(process.env.PUMBLE_APP_ID?.trim()) &&
      Boolean(process.env.PUMBLE_APP_KEY?.trim());
    const hasConfigValues =
      Boolean(resolvedAccount.config.appId) || Boolean(resolvedAccount.config.appKey);

    let appId: string | null = null;
    let appKey: string | null = null;
    let clientSecret: string | null = null;
    let signingSecret: string | null = null;

    if (!accountConfigured) {
      await notePumbleSetup(prompter);
    }

    if (canUseEnv && !hasConfigValues) {
      const keepEnv = await prompter.confirm({
        message: "PUMBLE_APP_ID + PUMBLE_APP_KEY detected. Use env vars?",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            pumble: {
              ...next.channels?.pumble,
              enabled: true,
            },
          },
        };
      } else {
        const entered = await promptPumbleCredentials(prompter);
        appId = entered.appId;
        appKey = entered.appKey;
        clientSecret = entered.clientSecret;
        signingSecret = entered.signingSecret;
      }
    } else if (accountConfigured) {
      const keep = await prompter.confirm({
        message: "Pumble credentials already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        const entered = await promptPumbleCredentials(prompter);
        appId = entered.appId;
        appKey = entered.appKey;
        clientSecret = entered.clientSecret;
        signingSecret = entered.signingSecret;
      }
    } else {
      const entered = await promptPumbleCredentials(prompter);
      appId = entered.appId;
      appKey = entered.appKey;
      clientSecret = entered.clientSecret;
      signingSecret = entered.signingSecret;
    }

    if (appId || appKey) {
      next = applyPumbleCredentials({
        cfg: next,
        accountId,
        creds: {
          ...(appId ? { appId } : {}),
          ...(appKey ? { appKey } : {}),
          ...(clientSecret ? { clientSecret } : {}),
          ...(signingSecret ? { signingSecret } : {}),
        },
      });
    }

    return { cfg: next, accountId };
  },
  disable: (cfg: OpenClawConfig) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      pumble: { ...cfg.channels?.pumble, enabled: false },
    },
  }),
};
