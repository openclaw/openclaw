//#region src/cli/wait.ts
function waitForever() {
	setInterval(() => {}, 1e6).unref();
	return new Promise(() => {});
}
//#endregion
export { waitForever as t };
