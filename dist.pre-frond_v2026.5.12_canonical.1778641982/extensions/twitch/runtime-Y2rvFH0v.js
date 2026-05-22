import { t as createPluginRuntimeStore } from "../../runtime-store-67Vxx2iX.js";
//#region extensions/twitch/src/runtime.ts
const { setRuntime: setTwitchRuntime, getRuntime: getTwitchRuntime } = createPluginRuntimeStore({
	pluginId: "twitch",
	errorMessage: "Twitch runtime not initialized"
});
//#endregion
export { setTwitchRuntime as n, getTwitchRuntime as t };
