//#region extensions/discord/src/monitor/format.ts
function resolveDiscordSystemLocation(params) {
	const { isDirectMessage, isGroupDm, guild, channelName } = params;
	if (isDirectMessage) return "DM";
	if (isGroupDm) return `Group DM #${channelName}`;
	return guild?.name ? `${guild.name} #${channelName}` : `#${channelName}`;
}
function formatDiscordReactionEmoji(emoji) {
	if (emoji.id && emoji.name) return `<:${emoji.name}:${emoji.id}>`;
	if (emoji.id) return `emoji:${emoji.id}`;
	return emoji.name ?? "emoji";
}
function formatDiscordUserTag(user) {
	const discriminator = (user.discriminator ?? "").trim();
	if (discriminator && discriminator !== "0") return `${user.username}#${discriminator}`;
	return user.username ?? user.id;
}
function resolveTimestampMs(timestamp) {
	if (!timestamp) return;
	const parsed = Date.parse(timestamp);
	return Number.isNaN(parsed) ? void 0 : parsed;
}
//#endregion
export { resolveTimestampMs as i, formatDiscordUserTag as n, resolveDiscordSystemLocation as r, formatDiscordReactionEmoji as t };
