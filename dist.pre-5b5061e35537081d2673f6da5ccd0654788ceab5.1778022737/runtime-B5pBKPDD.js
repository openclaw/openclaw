import { t as createPluginRuntimeStore } from "./runtime-store-BToSvHpc.js";
//#region extensions/bluebubbles/src/runtime.ts
const runtimeStore = createPluginRuntimeStore({
	pluginId: "bluebubbles",
	errorMessage: "BlueBubbles runtime not initialized"
});
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
