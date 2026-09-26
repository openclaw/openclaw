// Slack API module exposes the plugin public contract.
export { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
export {
  PAIRING_APPROVED_MESSAGE,
  projectCredentialSnapshotFields,
  resolveConfiguredFromRequiredCredentialStatuses,
} from "openclaw/plugin-sdk/channel-status";
export type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
export type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export { looksLikeSlackTargetId, normalizeSlackMessagingTarget } from "./target-parsing.js";

export const SLACK_CHANNEL_META = {
  id: "slack",
  label: "Slack",
  selectionLabel: "Slack",
  docsPath: "/channels/slack",
  docsLabel: "slack",
  blurb: "supports bot + app tokens, channels, threads, and interactive replies.",
  systemImage: "number.square",
  markdownCapable: true,
} as const;
