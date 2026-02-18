import type { ChannelOnboardingAdapter, OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import { promptAccountId } from "./onboarding-helpers.js";
import type { ZulipAccountConfig, ZulipConfig } from "./types.js";
import {
  listZulipAccountIds,
  resolveDefaultZulipAccountId,
  resolveZulipAccount,
} from "./zulip/accounts.js";

const channel = "zulip" as const;

async function noteZulipSetup(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Zulip settings -> Bots -> Create a bot",
      "2) Copy the bot email + API key",
      "3) Use your server base URL (e.g., https://chat.example.com)",
      "Tip: the bot must be a member of any stream you want it to monitor.",
      "Docs: https://docs.openclaw.ai/channels/zulip",
    ].join("\n"),
    "Zulip credentials",
  );
}

export const zulipOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listZulipAccountIds(cfg).some((accountId) => {
      const account = resolveZulipAccount({ cfg, accountId });
      return Boolean(account.apiKey && account.email && account.baseUrl);
    });
    return {
      channel,
      configured,
      statusLines: [`Zulip: ${configured ? "configured" : "needs api key + email + url"}`],
      selectionHint: configured ? "configured" : "needs setup",
      quickstartScore: configured ? 2 : 1,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const override = accountOverrides.zulip?.trim();
    const defaultAccountId = resolveDefaultZulipAccountId(cfg);
    let accountId = override ? normalizeAccountId(override) : defaultAccountId;
    if (shouldPromptAccountIds && !override) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        label: "Zulip",
        currentId: accountId,
        listAccountIds: listZulipAccountIds,
        defaultAccountId,
      });
    }

    let next = cfg;
    const resolvedAccount = resolveZulipAccount({
      cfg: next,
      accountId,
    });
    const accountConfigured = Boolean(
      resolvedAccount.apiKey && resolvedAccount.email && resolvedAccount.baseUrl,
    );
    const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv =
      allowEnv &&
      Boolean(process.env.ZULIP_API_KEY?.trim()) &&
      Boolean(process.env.ZULIP_EMAIL?.trim()) &&
      Boolean(process.env.ZULIP_URL?.trim());
    const hasConfigValues =
      Boolean(resolvedAccount.config.apiKey) ||
      Boolean(resolvedAccount.config.email) ||
      Boolean(resolvedAccount.config.url);

    let apiKey: string | null = null;
    let email: string | null = null;
    let baseUrl: string | null = null;

    if (!accountConfigured) {
      await noteZulipSetup(prompter);
    }

    if (canUseEnv && !hasConfigValues) {
      const keepEnv = await prompter.confirm({
        message: "ZULIP_API_KEY + ZULIP_EMAIL + ZULIP_URL detected. Use env vars?",
        initialValue: true,
      });
      if (keepEnv) {
        const zulipSection = (next.channels?.zulip ?? {}) as ZulipConfig;
        next = {
          ...next,
          channels: {
            ...next.channels,
            zulip: {
              ...zulipSection,
              enabled: true,
            },
          },
        };
      } else {
        apiKey = String(
          await prompter.text({
            message: "Enter Zulip API key",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        email = String(
          await prompter.text({
            message: "Enter Zulip bot email",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        baseUrl = String(
          await prompter.text({
            message: "Enter Zulip base URL",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else if (accountConfigured) {
      const keep = await prompter.confirm({
        message: "Zulip credentials already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        apiKey = String(
          await prompter.text({
            message: "Enter Zulip API key",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        email = String(
          await prompter.text({
            message: "Enter Zulip bot email",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        baseUrl = String(
          await prompter.text({
            message: "Enter Zulip base URL",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      apiKey = String(
        await prompter.text({
          message: "Enter Zulip API key",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
      email = String(
        await prompter.text({
          message: "Enter Zulip bot email",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
      baseUrl = String(
        await prompter.text({
          message: "Enter Zulip base URL",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (apiKey || email || baseUrl) {
      const zulipSection = (next.channels?.zulip ?? {}) as ZulipConfig;
      const zulipAccounts = (zulipSection.accounts ?? {}) as Record<string, ZulipAccountConfig>;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            zulip: {
              ...zulipSection,
              enabled: true,
              ...(apiKey ? { apiKey } : {}),
              ...(email ? { email } : {}),
              ...(baseUrl ? { url: baseUrl } : {}),
            },
          },
        };
      } else {
        next = {
          ...next,
          channels: {
            ...next.channels,
            zulip: {
              ...zulipSection,
              enabled: true,
              accounts: {
                ...zulipAccounts,
                [accountId]: {
                  ...zulipAccounts[accountId],
                  enabled: zulipAccounts[accountId]?.enabled ?? true,
                  ...(apiKey ? { apiKey } : {}),
                  ...(email ? { email } : {}),
                  ...(baseUrl ? { url: baseUrl } : {}),
                },
              },
            },
          },
        };
      }
    }

    return { cfg: next, accountId };
  },
  disable: (cfg: OpenClawConfig) => {
    const zulipSection = (cfg.channels?.zulip ?? {}) as ZulipConfig;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        zulip: { ...zulipSection, enabled: false },
      },
    };
  },
};
