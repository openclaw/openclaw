/**
 * 企业微信 onboarding adapter for CLI setup wizard.
 */

import {
  addWildcardAllowFrom,
  type ChannelOnboardingAdapter,
  type ChannelOnboardingDmPolicy,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk";
import { CHANNEL_ID } from "./const.ts";
import type { ResolvedWeComAccount } from "./utils.ts";
import { resolveWeComAccount, setWeComAccount } from "./utils.ts";

const channel = CHANNEL_ID;

/**
 * 企业微信设置帮助说明
 */
async function noteWeComSetupHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "企业微信机器人需要以下配置信息：",
      "1. Bot ID: 企业微信机器人id",
      "2. Secret: 企业微信机器人密钥",
    ].join("\n"),
    "企业微信设置",
  );
}

/**
 * 提示输入 Bot ID
 */
async function promptBotId(
  prompter: WizardPrompter,
  account: ResolvedWeComAccount | null,
): Promise<string> {
  return String(
    await prompter.text({
      message: "企业微信机器人 Bot ID",
      initialValue: account?.botId ?? "",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
}

/**
 * 提示输入 Secret
 */
async function promptSecret(
  prompter: WizardPrompter,
  account: ResolvedWeComAccount | null,
): Promise<string> {
  return String(
    await prompter.text({
      message: "企业微信机器人 Secret",
      initialValue: account?.secret ?? "",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
}

/**
 * 设置企业微信 dmPolicy
 */
function setWeComDmPolicy(
  cfg: OpenClawConfig,
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled",
): OpenClawConfig {
  const account = resolveWeComAccount(cfg);
  const existingAllowFrom = account.config.allowFrom ?? [];
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(existingAllowFrom.map((x) => String(x)))
      : existingAllowFrom.map((x) => String(x));

  return setWeComAccount(cfg, {
    dmPolicy,
    allowFrom,
  });
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "企业微信",
  channel,
  policyKey: `channels.${CHANNEL_ID}.dmPolicy`,
  allowFromKey: `channels.${CHANNEL_ID}.allowFrom`,
  getCurrent: (cfg) => {
    const account = resolveWeComAccount(cfg);
    return account.config.dmPolicy ?? "pairing";
  },
  setPolicy: (cfg, policy) => {
    return setWeComDmPolicy(cfg, policy);
  },
  promptAllowFrom: async ({ cfg, prompter }) => {
    const account = resolveWeComAccount(cfg);
    const existingAllowFrom = account.config.allowFrom ?? [];

    const entry = await prompter.text({
      message: "企业微信允许来源（用户ID或群组ID，每行一个，推荐用于安全控制）",
      placeholder: "user123 或 group456",
      initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
    });

    const allowFrom = String(entry ?? "")
      .split(/[\n,;]+/g)
      .map((s) => s.trim())
      .filter(Boolean);

    return setWeComAccount(cfg, { allowFrom });
  },
};

export const wecomOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const account = resolveWeComAccount(cfg);
    const configured = Boolean(account.botId?.trim() && account.secret?.trim());

    return {
      channel,
      configured,
      statusLines: [`企业微信: ${configured ? "已配置" : "需要 Bot ID 和 Secret"}`],
      selectionHint: configured ? "已配置" : "需要设置",
    };
  },
  configure: async ({ cfg, prompter, forceAllowFrom }) => {
    const account = resolveWeComAccount(cfg);

    if (!account.botId?.trim() || !account.secret?.trim()) {
      await noteWeComSetupHelp(prompter);
    }

    // 提示输入必要的配置信息：Bot ID 和 Secret
    const botId = await promptBotId(prompter, account);
    const secret = await promptSecret(prompter, account);

    // 使用默认值配置其他选项
    const cfgWithAccount = setWeComAccount(cfg, {
      botId,
      secret,
      enabled: true,
      dmPolicy: account.config.dmPolicy ?? "pairing",
      allowFrom: account.config.allowFrom ?? [],
    });

    return { cfg: cfgWithAccount };
  },
  dmPolicy,
  disable: (cfg) => {
    return setWeComAccount(cfg, { enabled: false });
  },
};
