import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const mattermostChannelConfigUiHints = {
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
  ...createChannelConfigUiHints({
    channelLabel: "Mattermost",
    dmPolicy: { channelKey: "mattermost" },
    implicitMentions: true,
    streaming: {
      "": 'Unified Mattermost stream preview mode: "off" | "partial" | "block" | "progress". "progress" keeps a single editable progress draft until final delivery.',
      mode: 'Canonical Mattermost preview mode: "off" | "partial" | "block" | "progress".',
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
