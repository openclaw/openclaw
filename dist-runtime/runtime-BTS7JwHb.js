import { y as createPluginRuntimeStore } from "./auth-profiles-B70DPAVa.js";
//#region extensions/bluebubbles/src/runtime.ts
const runtimeStore = createPluginRuntimeStore("BlueBubbles runtime not initialized");
const setBlueBubblesRuntime = runtimeStore.setRuntime;
function getBlueBubblesRuntime() {
	return runtimeStore.getRuntime();
}
function warnBlueBubbles(message) {
	const formatted = `[bluebubbles] ${message}`;
	const log = runtimeStore.tryGetRuntime()?.log;
	if (typeof log === "function") {
		log(formatted);
		return;
	}
	console.warn(formatted);
}
//#endregion
export { setBlueBubblesRuntime as n, warnBlueBubbles as r, getBlueBubblesRuntime as t };
