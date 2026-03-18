import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import { createScopedChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import { createChannelPluginBase } from "openclaw/plugin-sdk/core";
import {
  formatDocsLink,
  hasConfiguredSecretInput,
  patchChannelConfigForAccount,
} from "openclaw/plugin-sdk/setup";
import { inspectSlackAccount } from "./account-inspect.js";
import {
  listSlackAccountIds,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
  type ResolvedSlackAccount,
} from "./accounts.js";
import { isSlackInteractiveRepliesEnabled } from "./interactive-replies.js";
import {
  buildChannelConfigSchema,
  getChatChannelMeta,
  SlackConfigSchema,
  type ChannelPlugin,
  type OpenClawConfig,
} from "./runtime-api.js";

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

export const slackConfigAdapter = createScopedChannelConfigAdapter<ResolvedSlackAccount>({
  sectionKey: SLACK_CHANNEL,
  listAccountIds: listSlackAccountIds,
  resolveAccount: (cfg, accountId) => resolveSlackAccount({ cfg, accountId }),
  inspectAccount: (cfg, accountId) => inspectSlackAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultSlackAccountId,
  clearBaseFields: ["botToken", "appToken", "name"],
  resolveAllowFrom: (account: ResolvedSlackAccount) => account.dm?.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account: ResolvedSlackAccount) => account.config.defaultTo,
});

export function createSlackPluginBase(params: {
  setupWizard: NonNullable<ChannelPlugin<ResolvedSlackAccount>["setupWizard"]>;
  setup: NonNullable<ChannelPlugin<ResolvedSlackAccount>["setup"]>;
}): Pick<
  ChannelPlugin<ResolvedSlackAccount>,
  | "id"
  | "meta"
  | "setupWizard"
  | "capabilities"
  | "agentPrompt"
  | "streaming"
  | "reload"
  | "configSchema"
  | "config"
  | "setup"
> {
  return createChannelPluginBase({
    id: SLACK_CHANNEL,
    meta: {
      ...getChatChannelMeta(SLACK_CHANNEL),
      preferSessionLookupForAnnounceTarget: true,
    },
    setupWizard: params.setupWizard,
    capabilities: {
      chatTypes: ["direct", "channel", "thread"],
      reactions: true,
      threads: true,
      media: true,
      nativeCommands: true,
    },
    agentPrompt: {
      messageToolHints: ({ cfg, accountId }) =>
        isSlackInteractiveRepliesEnabled({ cfg, accountId })
          ? [
              "- Slack interactive replies: use `[[slack_buttons: Label:value, Other:other]]` to add action buttons that route clicks back as Slack interaction system events.",
              "- Slack selects: use `[[slack_select: Placeholder | Label:value, Other:other]]` to add a static select menu that routes the chosen value back as a Slack interaction system event.",
            ]
          : [
              "- Slack interactive replies are disabled. If needed, ask to set `channels.slack.capabilities.interactiveReplies=true` (or the same under `channels.slack.accounts.<account>.capabilities`).",
            ],
    },
    streaming: {
      blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
    },
    reload: { configPrefixes: ["channels.slack"] },
    configSchema: buildChannelConfigSchema(SlackConfigSchema),
    config: {
      ...slackConfigAdapter,
      isConfigured: (account) => isSlackPluginAccountConfigured(account),
      describeAccount: (account) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: isSlackPluginAccountConfigured(account),
        botTokenSource: account.botTokenSource,
        appTokenSource: account.appTokenSource,
      }),
    },
    setup: params.setup,
  }) as Pick<
    ChannelPlugin<ResolvedSlackAccount>,
    | "id"
    | "meta"
    | "setupWizard"
    | "capabilities"
    | "agentPrompt"
    | "streaming"
    | "reload"
    | "configSchema"
    | "config"
    | "setup"
  >;
}
