import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

export const whatsAppChannelConfigUiHints = {
  "": {
    label: "WhatsApp",
    help: "WhatsApp channel provider configuration for access policy and message batching behavior. Use this section to tune responsiveness and direct-message routing safety for WhatsApp chats.",
  },
  dmPolicy: {
    label: "WhatsApp DM Policy",
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.whatsapp.allowFrom=["*"].',
  },
  dmVisibleReplies: {
    label: "WhatsApp DM Visible Replies",
    help: 'Direct chat visible reply mode. "automatic" posts final replies normally; "message_tool" asks the agent to use message(action=send) and falls back to the final reply if no same-chat send happened.',
  },
  selfChatMode: {
    label: "WhatsApp Self-Phone Mode",
    help: "Same-phone setup (bot uses your personal WhatsApp number).",
  },
  debounceMs: {
    label: "WhatsApp Message Debounce (ms)",
    help: "Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable).",
  },
  configWrites: {
    label: "WhatsApp Config Writes",
    help: "Allow WhatsApp to write config in response to channel events/commands (default: true).",
  },
} satisfies Record<string, ChannelConfigUiHint>;
