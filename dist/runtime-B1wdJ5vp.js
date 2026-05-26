import { t as createPluginRuntimeStore } from "./runtime-store-Cigg_Veg.js";
//#region extensions/irc/src/runtime.ts
const { setRuntime: setIrcRuntime, clearRuntime: clearStoredIrcRuntime, getRuntime: getIrcRuntime } = createPluginRuntimeStore({
	pluginId: "irc",
	errorMessage: "IRC runtime not initialized"
});
//#endregion
export { setIrcRuntime as n, getIrcRuntime as t };
