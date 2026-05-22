export { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
export { PAIRING_APPROVED_MESSAGE, projectCredentialSnapshotFields, resolveConfiguredFromRequiredCredentialStatuses, } from "openclaw/plugin-sdk/channel-status";
export type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
export type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export { looksLikeSlackTargetId, normalizeSlackMessagingTarget } from "./target-parsing.js";
export declare function getChatChannelMeta(id: string): {
    readonly id: "slack";
    readonly label: "Slack";
    readonly selectionLabel: "Slack";
    readonly docsPath: "/channels/slack";
    readonly docsLabel: "slack";
    readonly blurb: "supports bot + app tokens, channels, threads, and interactive replies.";
    readonly systemImage: "number.square";
    readonly markdownCapable: true;
};
