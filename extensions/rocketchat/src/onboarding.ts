import type { ChannelOnboardingAdapter, OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { promptAccountId } from "./onboarding-helpers.js";
import {
  listRocketchatAccountIds,
  resolveDefaultRocketchatAccountId,
  resolveRocketchatAccount,
} from "./rocketchat/accounts.js";

const channel = "rocketchat" as const;

async function noteRocketchatSetup(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Rocket.Chat Admin -> My Account -> Personal Access Tokens",
      "2) Create a token + copy the token and user ID",
      "3) Use your server base URL (e.g., https://chat.example.com)",
      "Tip: the bot user must be a member of any channel you want it to monitor.",
      "Docs: https://docs.openclaw.ai/channels/rocketchat",
    ].join("\n"),
    "Rocket.Chat personal access token",
  );
}

export const rocketchatOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listRocketchatAccountIds(cfg).some((accountId) => {
      const account = resolveRocketchatAccount({ cfg, accountId });
      return Boolean(account.authToken && account.userId && account.baseUrl);
    });
    return {
      channel,
      configured,
      statusLines: [`Rocket.Chat: ${configured ? "configured" : "needs token + user ID + url"}`],
      selectionHint: configured ? "configured" : "needs setup",
      quickstartScore: configured ? 2 : 1,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const override = accountOverrides.rocketchat?.trim();
    const defaultAccountId = resolveDefaultRocketchatAccountId(cfg);
    let accountId = override ? normalizeAccountId(override) : defaultAccountId;
    if (shouldPromptAccountIds && !override) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        label: "Rocket.Chat",
        currentId: accountId,
        listAccountIds: listRocketchatAccountIds,
        defaultAccountId,
      });
    }

    let next = cfg;
    const resolvedAccount = resolveRocketchatAccount({
      cfg: next,
      accountId,
    });
    const accountConfigured = Boolean(
      resolvedAccount.authToken && resolvedAccount.userId && resolvedAccount.baseUrl,
    );
    const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv =
      allowEnv &&
      Boolean(process.env.ROCKETCHAT_AUTH_TOKEN?.trim()) &&
      Boolean(process.env.ROCKETCHAT_USER_ID?.trim()) &&
      Boolean(process.env.ROCKETCHAT_URL?.trim());
    const hasConfigValues =
      Boolean(resolvedAccount.config.authToken) ||
      Boolean(resolvedAccount.config.userId) ||
      Boolean(resolvedAccount.config.baseUrl);

    let authToken: string | null = null;
    let rcUserId: string | null = null;
    let baseUrl: string | null = null;

    if (!accountConfigured) {
      await noteRocketchatSetup(prompter);
    }

    if (canUseEnv && !hasConfigValues) {
      const keepEnv = await prompter.confirm({
        message:
          "ROCKETCHAT_AUTH_TOKEN + ROCKETCHAT_USER_ID + ROCKETCHAT_URL detected. Use env vars?",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            rocketchat: {
              ...next.channels?.rocketchat,
              enabled: true,
            },
          },
        };
      } else {
        authToken = String(
          await prompter.text({
            message: "Enter Rocket.Chat personal access token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        rcUserId = String(
          await prompter.text({
            message: "Enter Rocket.Chat user ID",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        baseUrl = String(
          await prompter.text({
            message: "Enter Rocket.Chat base URL",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else if (accountConfigured) {
      const keep = await prompter.confirm({
        message: "Rocket.Chat credentials already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        authToken = String(
          await prompter.text({
            message: "Enter Rocket.Chat personal access token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        rcUserId = String(
          await prompter.text({
            message: "Enter Rocket.Chat user ID",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        baseUrl = String(
          await prompter.text({
            message: "Enter Rocket.Chat base URL",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      authToken = String(
        await prompter.text({
          message: "Enter Rocket.Chat personal access token",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
      rcUserId = String(
        await prompter.text({
          message: "Enter Rocket.Chat user ID",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
      baseUrl = String(
        await prompter.text({
          message: "Enter Rocket.Chat base URL",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (authToken || rcUserId || baseUrl) {
      if (accountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            rocketchat: {
              ...next.channels?.rocketchat,
              enabled: true,
              ...(authToken ? { authToken } : {}),
              ...(rcUserId ? { userId: rcUserId } : {}),
              ...(baseUrl ? { baseUrl } : {}),
            },
          },
        };
      } else {
        next = {
          ...next,
          channels: {
            ...next.channels,
            rocketchat: {
              ...next.channels?.rocketchat,
              enabled: true,
              accounts: {
                ...next.channels?.rocketchat?.accounts,
                [accountId]: {
                  ...next.channels?.rocketchat?.accounts?.[accountId],
                  enabled: next.channels?.rocketchat?.accounts?.[accountId]?.enabled ?? true,
                  ...(authToken ? { authToken } : {}),
                  ...(rcUserId ? { userId: rcUserId } : {}),
                  ...(baseUrl ? { baseUrl } : {}),
                },
              },
            },
          },
        };
      }
    }

    return { cfg: next, accountId };
  },
  disable: (cfg: OpenClawConfig) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      rocketchat: { ...cfg.channels?.rocketchat, enabled: false },
    },
  }),
};
