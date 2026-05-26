import "./channel-status-DQzE7laT.js";
//#region extensions/slack/src/channel-api.ts
const SLACK_CHANNEL_META = {
	id: "slack",
	label: "Slack",
	selectionLabel: "Slack",
	docsPath: "/channels/slack",
	docsLabel: "slack",
	blurb: "supports bot + app tokens, channels, threads, and interactive replies.",
	systemImage: "number.square",
	markdownCapable: true
};
function getChatChannelMeta(id) {
	if (id !== SLACK_CHANNEL_META.id) throw new Error(`Unsupported Slack channel meta lookup: ${id}`);
	return SLACK_CHANNEL_META;
}
//#endregion
export { getChatChannelMeta as t };
