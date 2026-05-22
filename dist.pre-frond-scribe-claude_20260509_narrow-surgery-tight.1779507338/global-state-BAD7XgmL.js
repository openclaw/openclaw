//#region src/global-state.ts
let globalVerbose = false;
let globalYes = false;
function setVerbose(v) {
	globalVerbose = v;
}
function isVerbose() {
	return globalVerbose;
}
function setYes(v) {
	globalYes = v;
}
function isYes() {
	return globalYes;
}
//#endregion
export { setYes as i, isYes as n, setVerbose as r, isVerbose as t };
