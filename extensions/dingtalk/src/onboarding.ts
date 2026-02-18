import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ChannelOnboardingAdapter } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import { listDingTalkAccountIds, resolveDingTalkAccount } from "./accounts.js";
import { PLUGIN_ID } from "./constants.js";
import type { DingTalkConfig } from "./types.js";

const channel = PLUGIN_ID;

/**
 * Display DingTalk credentials configuration help
 */
async function noteDingTalkCredentialsHelp(prompter: {
  note: (message: string, title?: string) => Promise<void>;
}): Promise<void> {
  await prompter.note(
    [
      "1) Log in to DingTalk Open Platform: https://open.dingtalk.com",
      "2) Create an internal enterprise app -> Robot",
      "3) Get AppKey (Client ID) and AppSecret (Client Secret)",
      "4) Enable Stream mode in app configuration",
      "Docs: https://open.dingtalk.com/document/",
    ].join("\n"),
    "DingTalk bot setup",
  );
}

/**
 * DingTalk Onboarding Adapter（单账户模式）
 */
export const dingtalkOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listDingTalkAccountIds(cfg).some((accountId) => {
      const account = resolveDingTalkAccount({ cfg, accountId });
      return Boolean(account.clientId?.trim() && account.clientSecret?.trim());
    });
    return {
      channel,
      configured,
      statusLines: [`DingTalk: ${configured ? "configured" : "needs credentials"}`],
      selectionHint: configured ? "configured" : "needs AppKey/AppSecret",
      quickstartScore: configured ? 1 : 5,
    };
  },
  configure: async ({ cfg, prompter }) => {
    let next = cfg;
    const resolvedAccount = resolveDingTalkAccount({ cfg: next });
    const accountConfigured = Boolean(
      resolvedAccount.clientId?.trim() && resolvedAccount.clientSecret?.trim(),
    );
    const dingtalkConfig = (next.channels?.[PLUGIN_ID] ?? {}) as DingTalkConfig;
    const hasConfigCredentials = Boolean(dingtalkConfig.clientId);

    let clientId: string | null = null;
    let clientSecret: string | null = null;

    if (!accountConfigured) {
      await noteDingTalkCredentialsHelp(prompter);
    }

    if (hasConfigCredentials) {
      const keep = await prompter.confirm({
        message: "DingTalk credentials already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        clientId = String(
          await prompter.text({
            message: "Enter DingTalk AppKey (Client ID)",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        clientSecret = String(
          await prompter.text({
            message: "Enter DingTalk AppSecret (Client Secret)",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      clientId = String(
        await prompter.text({
          message: "Enter DingTalk AppKey (Client ID)",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
      clientSecret = String(
        await prompter.text({
          message: "Enter DingTalk AppSecret (Client Secret)",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (clientId && clientSecret) {
      const updatedDingtalkConfig = (next.channels?.[PLUGIN_ID] ?? {}) as DingTalkConfig;
      next = {
        ...next,
        channels: {
          ...next.channels,
          [PLUGIN_ID]: {
            ...updatedDingtalkConfig,
            enabled: true,
            clientId,
            clientSecret,
          },
        },
      };
    }

    return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
  },
  disable: (cfg) => {
    const dingtalkConfig = (cfg.channels?.[PLUGIN_ID] ?? {}) as DingTalkConfig;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        [PLUGIN_ID]: { ...dingtalkConfig, enabled: false },
      },
    };
  },
};
