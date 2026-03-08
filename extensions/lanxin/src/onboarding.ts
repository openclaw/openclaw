import type {
  ChannelOnboardingAdapter,
  ClawdbotConfig,
  WizardPrompter,
} from "openclaw/plugin-sdk/lanxin";
import { formatDocsLink } from "openclaw/plugin-sdk/lanxin";
import { resolveLanxinAccount } from "./accounts.js";

const channel = "lanxin" as const;

export const lanxinOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const account = resolveLanxinAccount({ cfg });
    return {
      channel,
      configured: account.configured,
      statusLines: [
        `Lanxin: ${account.configured ? "configured" : "needs app credentials"}`,
        account.aesKey
          ? "Lanxin webhook decrypt key: configured"
          : "Lanxin webhook decrypt key: missing",
      ],
      selectionHint: account.configured ? "configured" : "needs app creds",
      quickstartScore: account.configured ? 2 : 0,
    };
  },
  configure: async ({ cfg, prompter }) => {
    const account = resolveLanxinAccount({ cfg });
    if (account.configured) {
      const keep = await prompter.confirm({
        message: "Lanxin credentials already configured. Keep them?",
        initialValue: true,
      });
      if (keep) {
        return {
          cfg: {
            ...cfg,
            channels: {
              ...cfg.channels,
              lanxin: { ...cfg.channels?.lanxin, enabled: true },
            },
          },
        };
      }
    }

    await prompter.note(
      [
        "Create a Lanxin app at https://developer.lanxin.cn/",
        "Get AppID and AppSecret from the app settings.",
        `Docs: ${formatDocsLink("/channels/lanxin")}`,
      ].join("\n"),
    );
    const apiBaseUrl = String(
      await prompter.text({
        message: "Enter Lanxin API base URL",
        placeholder: "https://xxxx.e.lanxin.cn/open/apigw/v1/",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
    ).trim();

    const appId = String(
      await prompter.text({
        message: "Enter Lanxin App ID",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
    ).trim();
    const appSecret = String(
      await prompter.text({
        message: "Enter Lanxin App Secret",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
    ).trim();
    const aesKey = String(
      await prompter.text({
        message: "Enter Lanxin AES Key (for webhook decryption)",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
    ).trim();
    const defaultEntryId = String(
      await prompter.text({
        message: "Optional: default entryId for proactive/pairing sends (press enter to skip)",
      }),
    ).trim();

    return {
      cfg: {
        ...cfg,
        channels: {
          ...cfg.channels,
          lanxin: {
            ...cfg.channels?.lanxin,
            enabled: true,
            apiBaseUrl,
            appId,
            appSecret,
            aesKey,
            ...(defaultEntryId ? { defaultEntryId } : {}),
          },
        },
      } as ClawdbotConfig,
    };
  },
};
