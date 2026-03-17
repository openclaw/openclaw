import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime } = createPluginRuntimeStore("MSTeams runtime not initialized");
export {
  getMSTeamsRuntime,
  setMSTeamsRuntime
};
