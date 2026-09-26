import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
// Imessage helper module supports config ui hints behavior.
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

export const iMessageChannelConfigUiHints = {
  "": {
    label: "iMessage",
    help: "iMessage channel provider configuration for CLI integration and DM access policy handling. Use explicit CLI paths when runtime environments have non-standard binary locations.",
  },
  ...createChannelConfigUiHints({
    channelLabel: "iMessage",
    dmPolicy: { channelKey: "imessage" },
    configWrites: true,
  }),
  allowFrom: { presentation: "phone-number" },
  defaultTo: { presentation: "phone-number" },
  groupAllowFrom: { presentation: "phone-number" },
  "groups.*.requireMentionInBotThreads": {
    label: "iMessage Bot Thread Mention Requirement",
    help: "Override mention gating in native reply threads started by this account. False allows unmentioned replies; true requires a mention and keeps threads quiet when mention patterns are disabled. Omit to preserve normal gating. Ownership uses the bounded cache of messages OpenClaw sent; sender restrictions still apply.",
  },
  "accounts.*.groups.*.requireMentionInBotThreads": {
    label: "iMessage Account Bot Thread Mention Requirement",
    help: "Override mention gating in native reply threads whose root this account sent. Unknown or evicted roots keep the group's normal mention requirement.",
  },
  "accounts.*.allowFrom.*": { presentation: "phone-number" },
  "accounts.*.defaultTo": { presentation: "phone-number" },
  "accounts.*.groupAllowFrom.*": { presentation: "phone-number" },
  cliPath: {
    label: "iMessage CLI Path",
    help: "Filesystem path to the iMessage bridge CLI binary used for send/receive operations. Set explicitly when the binary is not on PATH in service runtime environments.",
  },
  sendTransport: {
    label: "iMessage Send Transport",
    help: 'Preferred imsg RPC send transport for normal outbound replies. "auto" uses the IMCore bridge when available, "bridge" requires it, and "applescript" forces Messages automation.',
  },
} satisfies Record<string, ChannelConfigUiHint>;
