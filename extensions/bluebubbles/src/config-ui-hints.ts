import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const bluebubblesChannelConfigUiHints = {
  "": {
    label: "BlueBubbles",
    help: "BlueBubbles channel provider configuration used for Apple messaging bridge integrations. Keep DM policy aligned with your trusted sender model in shared deployments.",
  },
  dmPolicy: {
    label: "BlueBubbles DM Policy",
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.bluebubbles.allowFrom=["*"].',
  },
  "direct.*.systemPrompt": {
    label: "Per-DM System Prompt",
    help: 'Free-form directive appended to the system prompt for DMs from a specific sender handle (e.g. "+15551234567") or "*" for all DMs. Mirrors the groups.<id>.systemPrompt pattern.',
  },
} satisfies Record<string, ChannelConfigUiHint>;
