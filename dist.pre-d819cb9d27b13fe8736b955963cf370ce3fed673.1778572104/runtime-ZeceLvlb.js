import { t as createPluginRuntimeStore } from "./runtime-store-C20iH_sr.js";
//#region extensions/feishu/src/runtime.ts
const { setRuntime: setFeishuRuntime, getRuntime: getFeishuRuntime } = createPluginRuntimeStore({
	pluginId: "feishu",
	errorMessage: "Feishu runtime not initialized"
});
//#endregion
export { setFeishuRuntime as n, getFeishuRuntime as t };
