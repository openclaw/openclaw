//#region extensions/discord/src/session-contract.ts
function deriveLegacySessionChatType(sessionKey) {
	return /^discord:(?:[^:]+:)?guild-[^:]+:channel-[^:]+$/.test(sessionKey) ? "channel" : void 0;
}
//#endregion
export { deriveLegacySessionChatType as t };
