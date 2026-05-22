import { t as createPluginRuntimeStore } from "./runtime-store-D7S_cOrU.js";
//#region extensions/feishu/src/runtime.ts
const { setRuntime: setFeishuRuntime, getRuntime: getFeishuRuntime } = createPluginRuntimeStore({
	pluginId: "feishu",
	errorMessage: "Feishu runtime not initialized"
});
//#endregion
export { setFeishuRuntime as n, getFeishuRuntime as t };
