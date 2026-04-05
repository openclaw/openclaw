export { DEFAULT_ACCOUNT_ID } from "mullusi/plugin-sdk/account-id";
export {
  PAIRING_APPROVED_MESSAGE,
  projectCredentialSnapshotFields,
  resolveConfiguredFromRequiredCredentialStatuses,
} from "mullusi/plugin-sdk/channel-status";
export type { ChannelPlugin } from "mullusi/plugin-sdk/channel-core";
export type { MullusiConfig } from "mullusi/plugin-sdk/config-runtime";
export { looksLikeSlackTargetId, normalizeSlackMessagingTarget } from "./target-parsing.js";

const SLACK_CHANNEL_META = {
  id: "slack",
  label: "Slack",
  selectionLabel: "Slack",
  docsPath: "/channels/slack",
  docsLabel: "slack",
  blurb: "supports bot + app tokens, channels, threads, and interactive replies.",
  systemImage: "number.square",
  markdownCapable: true,
} as const;

export function getChatChannelMeta(id: string) {
  if (id !== SLACK_CHANNEL_META.id) {
    throw new Error(`Unsupported Slack channel meta lookup: ${id}`);
  }
  return SLACK_CHANNEL_META;
}
