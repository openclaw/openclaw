//#region extensions/irc/configured-state.ts
function hasIrcConfiguredState(params) {
	return typeof params.env?.IRC_HOST === "string" && params.env.IRC_HOST.trim().length > 0 && typeof params.env?.IRC_NICK === "string" && params.env.IRC_NICK.trim().length > 0;
}
//#endregion
export { hasIrcConfiguredState };
