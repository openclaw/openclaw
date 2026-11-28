import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";
import { MattermostConfigSchema } from "./config-schema-core.js";

const mattermostChannelConfigUiHints = {
  "": {
    label: "Mattermost",
    help: "Mattermost channel provider configuration for bot auth, access policy, slash commands, and preview streaming.",
  },
  requireMentionInBotThreads: {
    label: "Mention in Bot Threads",
    help: "Require an explicit mention or configured trigger in threads rooted in this bot's own posts. Set false to accept unmentioned follow-ups; omit to preserve existing mention and participation behavior.",
  },
  "groups.*.requireMentionInBotThreads": {
    label: "Mention in Bot Threads",
    help: "Override bot-created thread mention policy for this Mattermost channel. Exact channel settings override the wildcard, then the account setting.",
  },
  allowBots: {
    label: "Mattermost Allow Bot Posts",
    help: 'Allow posts from Mattermost bot accounts to trigger replies (default: true). Set false to ignore them, or "mentions" to require an explicit @mention or onchar trigger in channels; thread participation does not count. Access, mention, and loop-protection rules still apply.',
  },
  "groups.*.allowBots": {
    label: "Mattermost Allow Bot Posts",
    help: "Override allowBots for this Mattermost channel. Exact channel settings override the wildcard, then the account setting.",
  },
  botLoopProtection: {
    label: "Mattermost Bot Loop Protection",
    help: "Sliding-window guard for Mattermost bot-to-bot loops. Default is enabled whenever allowBots lets bot posts reach dispatch.",
  },
  "botLoopProtection.enabled": {
    label: "Mattermost Bot Loop Protection Enabled",
    help: 'Enable the bot-pair loop guard. Defaults to true when allowBots is true or "mentions"; bot posts are ignored when allowBots is false.',
  },
  "botLoopProtection.maxEventsPerWindow": {
    label: "Mattermost Bot Loop Events per Window",
    help: "Maximum accepted bot-pair posts within the sliding window before suppression starts. Default: 20.",
  },
  "botLoopProtection.windowSeconds": {
    label: "Mattermost Bot Loop Window Seconds",
    help: "Sliding window length for counting bot-pair posts. Default: 60.",
  },
  "botLoopProtection.cooldownSeconds": {
    label: "Mattermost Bot Loop Cooldown Seconds",
    help: "How long to suppress the bot pair after it exceeds the budget. Default: 60.",
  },
  "groups.*.botLoopProtection": {
    label: "Mattermost Channel Bot Loop Protection",
    help: "Per-channel loop guard overrides, merged key by key over the wildcard and account settings.",
  },
  ...createChannelConfigUiHints({
    channelLabel: "Mattermost",
    dmPolicy: { channelKey: "mattermost" },
    implicitMentions: true,
    streaming: {
      "": 'Unified Mattermost stream preview mode: "off" | "partial" | "block" | "progress". "progress" keeps a single editable progress draft until final delivery.',
      mode: 'Mattermost preview mode: "off" | "partial" | "block" | "progress".',
      "block.enabled":
        'Enable chunked block-style Mattermost preview delivery when channels.mattermost.streaming.mode="block".',
      "block.coalesce": "Merge streamed Mattermost block replies before final delivery.",
      "preview.toolProgress":
        "Show tool/progress activity in the live draft preview post (default: true). Set false to hide interim tool updates while the draft preview stays active.",
      "preview.commandText":
        'Command/exec detail in preview tool-progress lines: "status" is the safe default; "raw" opts into command text.',
    },
    progress: {},
  }),
} satisfies Record<string, ChannelConfigUiHint>;

export const MattermostChannelConfigSchema = buildChannelConfigSchema(MattermostConfigSchema, {
  uiHints: mattermostChannelConfigUiHints,
});
