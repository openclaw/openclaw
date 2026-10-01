import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const msTeamsChannelConfigUiHints = {
  "": {
    label: "MS Teams",
    help: "Microsoft Teams channel provider configuration and provider-specific policy toggles. Use this section to isolate Teams behavior from other enterprise chat providers.",
  },
  configWrites: {
    label: "MS Teams Config Writes",
    help: "Allow Microsoft Teams to write config in response to channel events/commands (default: true).",
  },
  cloud: {
    label: "MS Teams Cloud",
    help: 'Teams SDK cloud environment for auth, token validation, and token services: "Public", "USGov", "USGovDoD", or "China" (default: Public).',
  },
  serviceUrl: {
    label: "MS Teams Service URL",
    help: "Bot Connector service URL for SDK proactive sends/edits/deletes. Set with cloud for USGov/DoD; set alone for GCC.",
  },
  graphMediaFallback: {
    label: "MS Teams Graph Media Fallback",
    help: "Query Microsoft Graph for unresolved channel or group-chat HTML media. Adds one lookup per matching message when enabled (default: false).",
  },
  requireMentionInBotThreads: {
    label: "Require Mentions in Bot Threads",
    help: "Override mention requirements for channel threads rooted at this bot's tracked messages. Unset preserves existing behavior. Channel overrides win over team and global values. Ownership tracking lasts up to 24 hours.",
  },
  "teams.*.requireMentionInBotThreads": {
    label: "Team Bot Thread Mentions",
    help: "Override mention requirements for this bot's channel threads in this team. Unset inherits the global value.",
  },
  "teams.*.channels.*.requireMentionInBotThreads": {
    label: "Channel Bot Thread Mentions",
    help: "Override mention requirements for this bot's threads in this channel. Unset inherits the team or global value.",
  },
  threadSessionPolicy: {
    label: "MS Teams Thread Session Policy",
    help: 'Channel conversation context: "thread" isolates each thread (default); "channel" shares context across threads in the same channel. Does not change reply placement or DM/group-chat sessions.',
  },
  "teams.*.threadSessionPolicy": {
    label: "MS Teams Team Thread Session Policy",
    help: "Default session context for channels in this team. Overrides the global threadSessionPolicy; individual channels can override it.",
  },
  "teams.*.channels.*.threadSessionPolicy": {
    label: "MS Teams Channel Thread Session Policy",
    help: 'Session context for this channel: "thread" isolates each thread; "channel" shares context across threads. Overrides team and global threadSessionPolicy.',
  },
  ...createChannelConfigUiHints({
    channelLabel: "MS Teams",
    streaming: {
      "": {
        label: "MS Teams Streaming",
        help: 'Microsoft Teams preview/progress streaming mode: "off" | "partial" | "block" | "progress". Personal chats use Teams native streaminfo progress when available.',
      },
    },
    progress: {
      labels: "openclaw",
      titleWording: true,
    },
  }),
} satisfies Record<string, ChannelConfigUiHint>;
