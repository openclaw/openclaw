import { t as createPluginRuntimeStore } from "./runtime-store-Ck0e4Li2.js";
//#region extensions/telegram/src/runtime.ts
const { setRuntime: setTelegramRuntime, clearRuntime: clearTelegramRuntime, getRuntime: getTelegramRuntime } = createPluginRuntimeStore({
	pluginId: "telegram",
	errorMessage: "Telegram runtime not initialized"
});
//#endregion
export { setTelegramRuntime as n, getTelegramRuntime as t };
