import type { OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk/core";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/core";
import { resolveYuanbaoAccount } from "./accounts.js";
import type { YuanbaoConfig } from "./types.js";

const channel = "yuanbao" as const;

/**
 * Display Yuanbao credential acquisition guide help info
 * @param prompter - Interactive prompter
 */
async function noteYuanbaoCredentialHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "You'll need values from YuanBao APP:",
      "",
      "• AppID & AppSecret → Create a robot from your Yuanbao APP to obtain.",
    ].join("\n"),
    "YuanBao Bot credentials",
  );
}

/**
 * Yuanbao channel onboarding adapter.
 *
 * Provides channel status check, credential configuration guidance, and disable operations
 * for the OpenClaw CLI interactive setup flow.
 */
export const yuanbaoOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }: { cfg: OpenClawConfig }) => {
    const account = resolveYuanbaoAccount({ cfg: cfg });
    const { configured } = account;

    const statusLines: string[] = [];
    if (!configured) {
      statusLines.push("YuanBao Bot: needs AppID + AppSecret");
    } else {
      statusLines.push(`YuanBao Bot: configured (AppID=${account.appKey ?? "?"})`);
    }

    return {
      channel,
      configured,
      statusLines,
      selectionHint: configured ? "configured" : "needs credentials",
      quickstartScore: configured ? 2 : 0,
    };
  },

  configure: async ({ cfg, prompter }: { cfg: OpenClawConfig; prompter: WizardPrompter }) => {
    const yuanbaoCfg = cfg.channels?.yuanbao as YuanbaoConfig | undefined;
    const hasConfigCreated = Boolean(yuanbaoCfg?.appKey?.trim() && yuanbaoCfg?.appSecret?.trim());

    let next = cfg;
    let appKey: string | null = null;
    let appSecret: string | null = null;

    if (!hasConfigCreated) {
      await noteYuanbaoCredentialHelp(prompter);
    }

    if (hasConfigCreated) {
      const keep = await prompter.confirm({
        message: "YuanBao Bot credentials already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        appKey = (
          await prompter.text({
            message: "Enter App ID (from bot application settings)",
            validate: (value: string) => (value?.trim() ? undefined : "Required"),
          })
        ).trim();
        appSecret = (
          await prompter.text({
            message: "Enter App Secret (from bot application settings)",
            validate: (value: string) => (value?.trim() ? undefined : "Required"),
          })
        ).trim();
      }
    } else {
      appKey = (
        await prompter.text({
          message: "Enter App ID (from bot application settings)",
          validate: (value: string) => (value?.trim() ? undefined : "Required"),
        })
      ).trim();
      appSecret = (
        await prompter.text({
          message: "Enter App Secret (from bot application settings)",
          validate: (value: string) => (value?.trim() ? undefined : "Required"),
        })
      ).trim();
    }

    if (appKey && appSecret) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          yuanbao: {
            ...next.channels?.yuanbao,
            enabled: true,
            appKey,
            appSecret,
          },
        },
      };
    }

    // Ensure enabled=true when keeping existing config
    next = {
      ...next,
      channels: {
        ...next.channels,
        yuanbao: {
          ...next.channels?.yuanbao,
          enabled: true,
        },
      },
    };

    return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
  },

  disable: (cfg: OpenClawConfig) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      yuanbao: { ...cfg.channels?.yuanbao, enabled: false },
    },
  }),
};
