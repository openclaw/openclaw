import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
//#region extensions/discord/src/runtime.ts
const { setRuntime: setDiscordRuntime, tryGetRuntime: getOptionalDiscordRuntime, getRuntime: getDiscordRuntime } = createPluginRuntimeStore({
	pluginId: "discord",
	errorMessage: "Discord runtime not initialized"
});
//#endregion
export { getOptionalDiscordRuntime as n, setDiscordRuntime as r, getDiscordRuntime as t };
