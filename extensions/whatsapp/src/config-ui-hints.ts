import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

const reconnectAttemptsHint = {
  label: "Reconnect Attempt Limit",
  help: "Failed connection attempts per recovery cycle. Default: 12. Must be a positive whole number. Exhausted cycles remain eligible for automatic recovery.",
};
const reconnectDelayHint = {
  label: "Maximum Reconnect Delay (ms)",
  help: "Cap for exponential reconnect delays in milliseconds. Default: 30000 (30 seconds). Minimum: 2000. Larger values reduce retry frequency during long outages.",
};

export const whatsAppChannelConfigUiHints = {
  "": {
    label: "WhatsApp",
    help: "WhatsApp channel provider configuration for access policy and direct-message routing safety.",
  },
  ...createChannelConfigUiHints({
    channelLabel: "WhatsApp",
    dmPolicy: { channelKey: "whatsapp" },
  }),
  allowFrom: { presentation: "phone-number" },
  defaultTo: { presentation: "phone-number" },
  groupAllowFrom: { presentation: "phone-number" },
  "accounts.*.allowFrom.*": { presentation: "phone-number" },
  "accounts.*.defaultTo": { presentation: "phone-number" },
  "accounts.*.groupAllowFrom.*": { presentation: "phone-number" },
  selfChatMode: {
    label: "WhatsApp Self-Phone Mode",
    help: "Same-phone setup (bot uses your personal WhatsApp number).",
  },
  reconnect: {
    label: "Connection Recovery",
    help: "Configure bounded reconnect cycles for temporary connection failures. Account overrides inherit omitted values.",
  },
  "reconnect.maxAttempts": reconnectAttemptsHint,
  "reconnect.maxMs": reconnectDelayHint,
  "accounts.*.reconnect.maxAttempts": reconnectAttemptsHint,
  "accounts.*.reconnect.maxMs": reconnectDelayHint,
  direct: {
    label: "WhatsApp Direct Chat Overrides",
    help: 'Per-conversation overrides keyed by WhatsApp DM id. Applied after a DM is already admitted by dmPolicy; "*" supplies a default without admitting anyone.',
  },
  pluginHooks: {
    label: "WhatsApp Plugin Hooks",
    help: "Opt in to broadcasting inbound WhatsApp events to plugins. Payloads carry personal content, so only enable it for plugins you trust.",
  },
  ...createChannelConfigUiHints({ channelLabel: "WhatsApp", configWrites: true }),
  "actions.calls": {
    label: "WhatsApp Voice Calls",
    help: "Expose the experimental requester-bound WhatsApp voice-call tool. Default: false. Requires a separately paired MeowCaller CLI.",
  },
  ...createChannelConfigUiHints({
    channelLabel: "WhatsApp",
    mentionPatterns: {
      targetDescription: "WhatsApp conversation IDs",
      policyTargetDescription: "WhatsApp conversation IDs such as 123@g.us",
    },
  }),
} satisfies Record<string, ChannelConfigUiHint>;
