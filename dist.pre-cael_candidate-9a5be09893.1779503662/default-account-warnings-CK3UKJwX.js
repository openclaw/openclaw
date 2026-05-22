//#region src/routing/default-account-warnings.ts
function formatChannelDefaultAccountPath(channelKey) {
	return `channels.${channelKey}.defaultAccount`;
}
function formatChannelAccountsDefaultPath(channelKey) {
	return `channels.${channelKey}.accounts.default`;
}
function formatSetExplicitDefaultInstruction(channelKey) {
	return `Set ${formatChannelDefaultAccountPath(channelKey)} or add ${formatChannelAccountsDefaultPath(channelKey)}`;
}
function formatSetExplicitDefaultToConfiguredInstruction(params) {
	return `Set ${formatChannelDefaultAccountPath(params.channelKey)} to one of these accounts, or add ${formatChannelAccountsDefaultPath(params.channelKey)}`;
}
//#endregion
export { formatSetExplicitDefaultInstruction as n, formatSetExplicitDefaultToConfiguredInstruction as r, formatChannelAccountsDefaultPath as t };
