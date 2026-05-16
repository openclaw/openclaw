//#region extensions/discord/configured-state.ts
function hasDiscordConfiguredState(params) {
	return typeof params.env?.DISCORD_BOT_TOKEN === "string" && params.env.DISCORD_BOT_TOKEN.trim().length > 0;
}
//#endregion
export { hasDiscordConfiguredState };
