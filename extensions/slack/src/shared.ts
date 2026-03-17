import { patchChannelConfigForAccount } from "../../../src/channels/plugins/setup-wizard-helpers.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { hasConfiguredSecretInput } from "../../../src/config/types.secrets.js";
import { formatAllowFromLowercase } from "../../../src/plugin-sdk/allow-from.js";
import {
  createScopedAccountConfigAccessors,
  createScopedChannelConfigBase,
} from "../../../src/plugin-sdk/channel-config-helpers.js";
import { formatDocsLink } from "../../../src/terminal/links.js";
import { inspectSlackAccount } from "./account-inspect.js";
import {
  listSlackAccountIds,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
  type ResolvedSlackAccount,
} from "./accounts.js";

export const SLACK_CHANNEL = "slack" as const;

function buildSlackManifest(botName: string) {
  const safeName = botName.trim() || "OpenClaw";
  const manifest = {
    display_information: {
      name: safeName,
      description: `${safeName} connector for OpenClaw`,
    },
    features: {
      bot_user: {
        display_name: safeName,
        always_online: false,
      },
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      slash_commands: [
        {
          command: "/openclaw",
          description: "Send a message to OpenClaw",
          should_escape: false,
        },
      ],
    },
    oauth_config: {
      scopes: {
        bot: [
          "chat:write",
          "channels:history",
          "channels:read",
          "groups:history",
          "im:history",
          "mpim:history",
          "users:read",
          "app_mentions:read",
          "reactions:read",
          "reactions:write",
          "pins:read",
          "pins:write",
          "emoji:read",
          "commands",
          "files:read",
          "files:write",
        ],
      },
    },
    settings: {
      socket_mode_enabled: true,
      event_subscriptions: {
        bot_events: [
          "app_mention",
          "message.channels",
          "message.groups",
          "message.im",
          "message.mpim",
          "reaction_added",
          "reaction_removed",
          "member_joined_channel",
          "member_left_channel",
          "channel_rename",
          "pin_added",
          "pin_removed",
        ],
      },
    },
  };
  return JSON.stringify(manifest, null, 2);
}

export function buildSlackSetupLines(botName = "OpenClaw"): string[] {
  return [
    "1) Slack API -> Create App -> From scratch or From manifest (with the JSON below)",
    "2) Add Socket Mode + enable it to get the app-level token (xapp-...)",
    "3) Install App to workspace to get the xoxb- bot token",
    "4) Enable Event Subscriptions (socket) for message events",
    "5) App Home -> enable the Messages tab for DMs",
    "Tip: set SLACK_BOT_TOKEN + SLACK_APP_TOKEN in your env.",
    `Docs: ${formatDocsLink("/slack", "slack")}`,
    "",
    "Manifest (JSON):",
    buildSlackManifest(botName),
  ];
}

export function setSlackChannelAllowlist(
  cfg: OpenClawConfig,
  accountId: string,
  channelKeys: string[],
): OpenClawConfig {
  const channels = Object.fromEntries(channelKeys.map((key) => [key, { allow: true }]));
  return patchChannelConfigForAccount({
    cfg,
    channel: SLACK_CHANNEL,
    accountId,
    patch: { channels },
  });
}

export function isSlackPluginAccountConfigured(account: ResolvedSlackAccount): boolean {
  const mode = account.config.mode ?? "socket";
  const hasBotToken = Boolean(account.botToken?.trim());
  if (!hasBotToken) {
    return false;
  }
  if (mode === "http") {
    return Boolean(account.config.signingSecret?.trim());
  }
  return Boolean(account.appToken?.trim());
}

export function isSlackSetupAccountConfigured(account: ResolvedSlackAccount): boolean {
  const hasConfiguredBotToken =
    Boolean(account.botToken?.trim()) || hasConfiguredSecretInput(account.config.botToken);
  const hasConfiguredAppToken =
    Boolean(account.appToken?.trim()) || hasConfiguredSecretInput(account.config.appToken);
  return hasConfiguredBotToken && hasConfiguredAppToken;
}

export const slackConfigAccessors = createScopedAccountConfigAccessors({
  resolveAccount: ({ cfg, accountId }) => resolveSlackAccount({ cfg, accountId }),
  resolveAllowFrom: (account: ResolvedSlackAccount) => account.dm?.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account: ResolvedSlackAccount) => account.config.defaultTo,
});

export const slackConfigBase = createScopedChannelConfigBase({
  sectionKey: SLACK_CHANNEL,
  listAccountIds: listSlackAccountIds,
  resolveAccount: (cfg, accountId) => resolveSlackAccount({ cfg, accountId }),
  inspectAccount: (cfg, accountId) => inspectSlackAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultSlackAccountId,
  clearBaseFields: ["botToken", "appToken", "name"],
});
