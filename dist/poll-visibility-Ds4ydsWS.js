//#region extensions/telegram/src/poll-visibility.ts
function resolveTelegramPollVisibility(params) {
	if (params.pollAnonymous && params.pollPublic) throw new Error("pollAnonymous and pollPublic are mutually exclusive");
	if (params.pollAnonymous) return true;
	if (params.pollPublic) return false;
}
//#endregion
export { resolveTelegramPollVisibility as t };
