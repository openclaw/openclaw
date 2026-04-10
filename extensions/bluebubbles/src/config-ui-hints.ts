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
  sendMethod: {
    label: "BlueBubbles Send Method",
    help: 'Optional outbound delivery method override. Use "apple-script" on hosts where the default BlueBubbles HTTP send path does not deliver without an explicit method; use "private-api" only when the server Private API is enabled.',
  },
} satisfies Record<string, ChannelConfigUiHint>;
