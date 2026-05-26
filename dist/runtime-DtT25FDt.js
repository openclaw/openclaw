import { t as createPluginRuntimeStore } from "./runtime-store-Cigg_Veg.js";
//#region extensions/tlon/src/runtime.ts
const { setRuntime: setTlonRuntime, getRuntime: getTlonRuntime } = createPluginRuntimeStore({
	pluginId: "tlon",
	errorMessage: "Tlon runtime not initialized"
});
//#endregion
export { setTlonRuntime as n, getTlonRuntime as t };
