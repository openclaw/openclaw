import type { ChannelOnboardingAdapter, OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import { promptAccountId } from "./onboarding-helpers.js";
import {
  listZulipAccountIds,
  resolveDefaultZulipAccountId,
  resolveZulipAccount,
} from "./zulip/accounts.js";

const channel = "zulip" as const;

async function noteZulipSetup(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Create a Zulip bot and copy its API key",
      "2) Ensure the bot is subscribed to the stream(s) you want to monitor",
      "3) Configure base URL + bot email + API key + stream allowlist",
      "Docs: https://docs.openclaw.ai/channels/zulip",
    ].join("\n"),
    "Zulip bot credentials",
  );
}

export const zulipOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listZulipAccountIds(cfg).some((accountId) => {
      const account = resolveZulipAccount({ cfg, accountId });
      return Boolean(account.baseUrl && account.email && account.apiKey && account.streams.length);
    });
    return {
      channel,
      configured,
      statusLines: [
        `Zulip: ${configured ? "configured" : "needs baseUrl + email + apiKey + streams"}`,
      ],
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
    const resolvedAccount = resolveZulipAccount({ cfg: next, accountId });
    const accountConfigured = Boolean(
      resolvedAccount.baseUrl && resolvedAccount.email && resolvedAccount.apiKey,
    );

    const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv =
      allowEnv &&
      Boolean(process.env.ZULIP_URL?.trim()) &&
      Boolean(process.env.ZULIP_EMAIL?.trim()) &&
      Boolean(process.env.ZULIP_API_KEY?.trim());

    let baseUrl: string | null = null;
    let email: string | null = null;
    let apiKey: string | null = null;
    let streams: string[] | null = null;

    if (!accountConfigured) {
      await noteZulipSetup(prompter);
    }

    if (canUseEnv) {
      const keepEnv = await prompter.confirm({
        message: "ZULIP_URL + ZULIP_EMAIL + ZULIP_API_KEY detected. Use env vars?",
        initialValue: true,
      });
      if (!keepEnv) {
        baseUrl = String(
          await prompter.text({
            message: "Enter Zulip base URL",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        email = String(
          await prompter.text({
            message: "Enter Zulip bot email",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        apiKey = String(
          await prompter.text({
            message: "Enter Zulip bot API key",
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
        baseUrl = String(
          await prompter.text({
            message: "Enter Zulip base URL",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        email = String(
          await prompter.text({
            message: "Enter Zulip bot email",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        apiKey = String(
          await prompter.text({
            message: "Enter Zulip bot API key",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      baseUrl = String(
        await prompter.text({
          message: "Enter Zulip base URL",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
      email = String(
        await prompter.text({
          message: "Enter Zulip bot email",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
      apiKey = String(
        await prompter.text({
          message: "Enter Zulip bot API key",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    const streamsRaw = String(
      await prompter.text({
        message: "Streams to monitor (comma-separated, e.g. marcel-ai, general)",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
    );
    streams = streamsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (baseUrl || email || apiKey || streams) {
      if (accountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            zulip: {
              ...next.channels?.zulip,
              enabled: true,
              ...(baseUrl ? { baseUrl } : {}),
              ...(email ? { email } : {}),
              ...(apiKey ? { apiKey } : {}),
              ...(streams ? { streams } : {}),
            },
          },
        };
      } else {
        next = {
          ...next,
          channels: {
            ...next.channels,
            zulip: {
              ...next.channels?.zulip,
              enabled: true,
              accounts: {
                ...next.channels?.zulip?.accounts,
                [accountId]: {
                  ...next.channels?.zulip?.accounts?.[accountId],
                  enabled: next.channels?.zulip?.accounts?.[accountId]?.enabled ?? true,
                  ...(baseUrl ? { baseUrl } : {}),
                  ...(email ? { email } : {}),
                  ...(apiKey ? { apiKey } : {}),
                  ...(streams ? { streams } : {}),
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
      zulip: { ...cfg.channels?.zulip, enabled: false },
    },
  }),
};
