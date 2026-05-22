export { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
export { buildTokenChannelStatusSummary, PAIRING_APPROVED_MESSAGE, projectCredentialSnapshotFields, resolveConfiguredFromCredentialStatuses, } from "openclaw/plugin-sdk/channel-status";
export type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
export type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export declare function getChatChannelMeta(id: string): {
    readonly id: "discord";
    readonly label: "Discord";
    readonly selectionLabel: "Discord (Bot API)";
    readonly detailLabel: "Discord Bot";
    readonly docsPath: "/channels/discord";
    readonly docsLabel: "discord";
    readonly blurb: "very well supported right now.";
    readonly systemImage: "bubble.left.and.bubble.right";
    readonly markdownCapable: true;
    readonly preferSessionLookupForAnnounceTarget: true;
};
