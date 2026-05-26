//#region src/channels/plugins/threading-helpers.ts
function createStaticReplyToModeResolver(mode) {
	return () => mode;
}
function createTopLevelChannelReplyToModeResolver(channelId) {
	return ({ cfg }) => {
		return (cfg.channels?.[channelId])?.replyToMode ?? "off";
	};
}
function createScopedAccountReplyToModeResolver(params) {
	return ({ cfg, accountId, chatType }) => params.resolveReplyToMode(params.resolveAccount(cfg, accountId), chatType) ?? params.fallback ?? "off";
}
//#endregion
export { createStaticReplyToModeResolver as n, createTopLevelChannelReplyToModeResolver as r, createScopedAccountReplyToModeResolver as t };
