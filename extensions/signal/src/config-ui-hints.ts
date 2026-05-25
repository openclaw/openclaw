import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

export const signalChannelConfigUiHints = {
  "": {
    label: "Signal",
    help: "Signal channel provider configuration including account identity and DM policy behavior. Keep account mapping explicit so routing remains stable across multi-device setups.",
  },
  dmPolicy: {
    label: "Signal DM Policy",
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.signal.allowFrom=["*"].',
  },
  configWrites: {
    label: "Signal Config Writes",
    help: "Allow Signal to write config in response to channel events/commands (default: true).",
  },
  account: {
    label: "Signal Account",
    help: "Signal account identifier (phone/number handle) used to bind this channel config to a specific Signal identity. Keep this aligned with your linked device/session state.",
  },
  enableMessageSendingHook: {
    label: "Enable Message Sending Hook",
    help: "Allow message_sending plugin hooks (content gates, DLP filters, audit) to inspect, modify, or cancel Signal replies before delivery. Defaults to false; will default to true in a future major version.",
  },
} satisfies Record<string, ChannelConfigUiHint>;
