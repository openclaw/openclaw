import { t as createPluginRuntimeStore } from "./runtime-store-D7S_cOrU.js";
//#region extensions/matrix/src/runtime.ts
const { setRuntime: setMatrixRuntime, getRuntime: getMatrixRuntime, tryGetRuntime: getOptionalMatrixRuntime } = createPluginRuntimeStore({
	pluginId: "matrix",
	errorMessage: "Matrix runtime not initialized"
});
//#endregion
export { getOptionalMatrixRuntime as n, setMatrixRuntime as r, getMatrixRuntime as t };
