//#region src/channels/plugins/outbound/interactive.ts
function reduceInteractiveReply(interactive, initialState, reduce) {
	let state = initialState;
	for (const [index, block] of (interactive?.blocks ?? []).entries()) state = reduce(state, block, index);
	return state;
}
//#endregion
export { reduceInteractiveReply as t };
