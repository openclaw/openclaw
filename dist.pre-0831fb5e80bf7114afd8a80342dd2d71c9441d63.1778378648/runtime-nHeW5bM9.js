import { t as createPluginRuntimeStore } from "./runtime-store-BY975gH9.js";
//#region extensions/whatsapp/src/runtime.ts
const { setRuntime: setWhatsAppRuntime, getRuntime: getWhatsAppRuntime } = createPluginRuntimeStore({
	pluginId: "whatsapp",
	errorMessage: "WhatsApp runtime not initialized"
});
//#endregion
export { setWhatsAppRuntime as n, getWhatsAppRuntime as t };
