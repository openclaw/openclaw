import { t as createPluginRuntimeStore } from "./runtime-store-BY975gH9.js";
//#region extensions/mattermost/src/runtime.ts
const { setRuntime: setMattermostRuntime, getRuntime: getMattermostRuntime } = createPluginRuntimeStore({
	pluginId: "mattermost",
	errorMessage: "Mattermost runtime not initialized"
});
//#endregion
export { setMattermostRuntime as n, getMattermostRuntime as t };
