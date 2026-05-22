//#region extensions/matrix/src/matrix/sync-state.ts
function isMatrixReadySyncState(state) {
	return state === "PREPARED" || state === "SYNCING" || state === "CATCHUP";
}
function isMatrixDisconnectedSyncState(state) {
	return state === "RECONNECTING" || state === "ERROR" || state === "STOPPED";
}
function isMatrixTerminalSyncState(state) {
	return state === "STOPPED";
}
//#endregion
export { isMatrixReadySyncState as n, isMatrixTerminalSyncState as r, isMatrixDisconnectedSyncState as t };
