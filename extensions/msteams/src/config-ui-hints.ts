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
  streaming: {
    label: "MS Teams Streaming",
    help: 'Microsoft Teams preview/progress streaming mode: "off" | "partial" | "block" | "progress". Personal chats use Teams native streaminfo progress when available.',
  },
  "streaming.progress.label": {
    label: "MS Teams Progress Label",
    help: 'Initial progress title. Use "auto" for built-in single-word labels, a custom string, or false to hide the title.',
  },
} satisfies Record<string, ChannelConfigUiHint>;
