import { DEFAULT_ACCOUNT_ID as DEFAULT_ACCOUNT_ID$1 } from "openclaw/plugin-sdk/account-id";
import { PAIRING_APPROVED_MESSAGE, buildTokenChannelStatusSummary, projectCredentialSnapshotFields, resolveConfiguredFromCredentialStatuses } from "openclaw/plugin-sdk/channel-status";
//#region extensions/discord/src/channel-api.ts
const DISCORD_CHANNEL_META = {
	id: "discord",
	label: "Discord",
	selectionLabel: "Discord (Bot API)",
	detailLabel: "Discord Bot",
	docsPath: "/channels/discord",
	docsLabel: "discord",
	blurb: "very well supported right now.",
	systemImage: "bubble.left.and.bubble.right",
	markdownCapable: true,
	preferSessionLookupForAnnounceTarget: true
};
function getChatChannelMeta(id) {
	if (id !== DISCORD_CHANNEL_META.id) throw new Error(`Unsupported Discord channel meta lookup: ${id}`);
	return DISCORD_CHANNEL_META;
}
//#endregion
export { projectCredentialSnapshotFields as a, getChatChannelMeta as i, PAIRING_APPROVED_MESSAGE as n, resolveConfiguredFromCredentialStatuses as o, buildTokenChannelStatusSummary as r, DEFAULT_ACCOUNT_ID$1 as t };
