import { t as createPluginRuntimeStore } from "./runtime-store-2ORR7yfg.js";
//#region extensions/discord/src/runtime.ts
const { setRuntime: setDiscordRuntime, tryGetRuntime: getOptionalDiscordRuntime, getRuntime: getDiscordRuntime } = createPluginRuntimeStore({
	pluginId: "discord",
	errorMessage: "Discord runtime not initialized"
});
//#endregion
export { getOptionalDiscordRuntime as n, setDiscordRuntime as r, getDiscordRuntime as t };
