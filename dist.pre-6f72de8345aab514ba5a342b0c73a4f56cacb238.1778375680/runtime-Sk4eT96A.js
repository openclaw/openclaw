import { t as createPluginRuntimeStore } from "./runtime-store-D7S_cOrU.js";
//#region extensions/whatsapp/src/runtime.ts
const { setRuntime: setWhatsAppRuntime, getRuntime: getWhatsAppRuntime } = createPluginRuntimeStore({
	pluginId: "whatsapp",
	errorMessage: "WhatsApp runtime not initialized"
});
//#endregion
export { setWhatsAppRuntime as n, getWhatsAppRuntime as t };
