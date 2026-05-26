import { t as createPluginRuntimeStore } from "./runtime-store-Cigg_Veg.js";
//#region extensions/slack/src/runtime.ts
const { setRuntime: setSlackRuntime, clearRuntime: clearSlackRuntime, tryGetRuntime: getOptionalSlackRuntime } = createPluginRuntimeStore({
	pluginId: "slack",
	errorMessage: "Slack runtime not initialized"
});
//#endregion
export { setSlackRuntime as n, getOptionalSlackRuntime as t };
