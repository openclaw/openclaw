import { t as createPluginRuntimeStore } from "./runtime-store-2ORR7yfg.js";
//#region extensions/zalo/src/runtime.ts
const { setRuntime: setZaloRuntime, getRuntime: getZaloRuntime } = createPluginRuntimeStore({
	pluginId: "zalo",
	errorMessage: "Zalo runtime not initialized"
});
//#endregion
export { setZaloRuntime as n, getZaloRuntime as t };
