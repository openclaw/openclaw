/**
 * WeCom setupWizard — declarative CLI setup wizard configuration.
 *
 * The framework identifies and drives the channel's guided configuration flow
 * via the plugin.setupWizard field.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ChannelSetupWizard, ChannelSetupDmPolicy } from "openclaw/plugin-sdk/setup";
import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/setup";
import { resolveWeComAccountMulti, setWeComAccountMulti } from "./accounts.js";
import { CHANNEL_ID } from "./const.js";
import { addWildcardAllowFrom } from "./openclaw-compat.js";
import type { WeComConfig } from "./utils.js";

// ============================================================================
// ChannelSetupAdapter — adapter used by the framework to apply config input
// ============================================================================

export const wecomSetupAdapter: ChannelSetupAdapter = {
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const patch: Partial<WeComConfig> = {};

    if (input.token !== undefined) {
      patch.botId = input.token.trim();
    }
    if (input.privateKey !== undefined) {
      patch.secret = input.privateKey.trim();
    }

    // Enable by default on first-time configuration
    const account = resolveWeComAccountMulti({ cfg, accountId });
    if (!account.botId && !account.secret) {
      patch.enabled = true;
    }

    return setWeComAccountMulti(cfg, patch, accountId);
  },
};

// ============================================================================
// DM Policy configuration
// ============================================================================

/**
 * Set WeCom dmPolicy for the given account (or the default account when omitted).
 */
function setWeComDmPolicy(
  cfg: OpenClawConfig,
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled",
  accountId?: string,
): OpenClawConfig {
  const account = resolveWeComAccountMulti({ cfg, accountId });
  const existingAllowFrom = account.config.allowFrom ?? [];
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(existingAllowFrom.map((x) => String(x)))
      : existingAllowFrom.map((x) => String(x));

  return setWeComAccountMulti(
    cfg,
    {
      dmPolicy,
      allowFrom,
    },
    accountId,
  );
}

const dmPolicy: ChannelSetupDmPolicy = {
  label: "WeCom",
  channel: CHANNEL_ID,
  policyKey: `channels.${CHANNEL_ID}.dmPolicy`,
  allowFromKey: `channels.${CHANNEL_ID}.allowFrom`,
  getCurrent: (cfg, accountId) => {
    const account = resolveWeComAccountMulti({ cfg, accountId });
    return account.config.dmPolicy ?? "open";
  },
  setPolicy: (cfg, policy, accountId) => {
    return setWeComDmPolicy(cfg, policy, accountId);
  },
  promptAllowFrom: async ({ cfg, prompter, accountId }) => {
    const account = resolveWeComAccountMulti({ cfg, accountId });
    const existingAllowFrom = account.config.allowFrom ?? [];

    const entry = await prompter.text({
      message: "WeCom allow-from (user ID or group ID, comma-separated)",
      placeholder: "user123, group456",
      initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
    });

    const allowFrom = (entry ?? "")
      .split(/[\n,;]+/g)
      .map((s) => s.trim())
      .filter(Boolean);

    return setWeComAccountMulti(cfg, { allowFrom }, accountId);
  },
};

// ============================================================================
// ChannelSetupWizard — declarative setup wizard configuration
// ============================================================================

export const wecomSetupWizard: ChannelSetupWizard = {
  channel: CHANNEL_ID,

  // ── Status ────────────────────────────────────────────────────────────
  status: {
    configuredLabel: "Configured ✓",
    unconfiguredLabel: "Bot ID and Secret required",
    configuredHint: "Configured",
    unconfiguredHint: "Setup required",
    resolveConfigured: ({ cfg }) => {
      const account = resolveWeComAccountMulti({ cfg });
      return Boolean(account.botId?.trim() && account.secret?.trim());
    },
    resolveStatusLines: ({ configured }) => {
      return [`WeCom: ${configured ? "Configured" : "Bot ID and Secret required"}`];
    },
  },

  // ── Intro note ────────────────────────────────────────────────────────
  introNote: {
    title: "WeCom Setup",
    lines: [
      "WeCom bot requires the following configuration:",
      "1. Bot ID: WeCom bot ID",
      "2. Secret: WeCom bot secret key",
      "",
      "Find these in the WeCom Admin Console → Smart Bots:",
      "  https://work.weixin.qq.com/wework_admin/frame#/aiHelper/list?from=openclaw",
      "",
      "Setup guide: https://docs.openclaw.ai/channels/wecom",
    ],
    shouldShow: ({ cfg }) => {
      const account = resolveWeComAccountMulti({ cfg });
      return !account.botId?.trim() || !account.secret?.trim();
    },
  },

  // ── Credentials input ──────────────────────────────────────────────────
  credentials: [
    {
      inputKey: "token",
      providerHint: "WeCom",
      credentialLabel: "Bot ID",
      envPrompt: "Use Bot ID from environment variable?",
      keepPrompt: "Bot ID is configured, keep current value?",
      inputPrompt: "WeCom bot Bot ID",
      inspect: ({ cfg, accountId }) => {
        const account = resolveWeComAccountMulti({ cfg, accountId });
        const hasValue = Boolean(account.botId?.trim());
        return {
          accountConfigured: hasValue,
          hasConfiguredValue: hasValue,
          resolvedValue: account.botId || undefined,
        };
      },
      applySet: ({ cfg, accountId, resolvedValue }) => {
        return setWeComAccountMulti(cfg, { botId: resolvedValue }, accountId);
      },
    },
    {
      inputKey: "privateKey",
      providerHint: "WeCom",
      credentialLabel: "Secret",
      envPrompt: "Use Secret from environment variable?",
      keepPrompt: "Secret is configured, keep current value?",
      inputPrompt: "WeCom bot Secret",
      inspect: ({ cfg, accountId }) => {
        const account = resolveWeComAccountMulti({ cfg, accountId });
        const hasValue = Boolean(account.secret?.trim());
        return {
          accountConfigured: hasValue,
          hasConfiguredValue: hasValue,
          resolvedValue: account.secret || undefined,
        };
      },
      applySet: ({ cfg, accountId, resolvedValue }) => {
        return setWeComAccountMulti(cfg, { secret: resolvedValue }, accountId);
      },
    },
  ],

  // ── Post-completion finalization ──────────────────────────────────────
  finalize: async ({ cfg }) => {
    // Ensure the channel is enabled after configuration is complete
    const account = resolveWeComAccountMulti({ cfg });
    if (account.botId?.trim() && account.secret?.trim() && !account.enabled) {
      return { cfg: setWeComAccountMulti(cfg, { enabled: true }) };
    }
    return undefined;
  },

  // ── Completion note ──────────────────────────────────────────────────
  completionNote: {
    title: "WeCom Configuration Complete",
    lines: ["WeCom bot has been configured.", "Run `openclaw start` to start the service."],
    shouldShow: ({ cfg }) => {
      const account = resolveWeComAccountMulti({ cfg });
      return Boolean(account.botId?.trim() && account.secret?.trim());
    },
  },

  // ── DM policy ────────────────────────────────────────────────────────
  dmPolicy,

  // ── Disable ────────────────────────────────────────────────────────────
  disable: (cfg) => {
    return setWeComAccountMulti(cfg, { enabled: false });
  },
};
