import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
const { setRuntime: setMattermostRuntime, getRuntime: getMattermostRuntime } = createPluginRuntimeStore("Mattermost runtime not initialized");
export {
  getMattermostRuntime,
  setMattermostRuntime
};
