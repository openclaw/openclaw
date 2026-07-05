// Mattermost plugin module implements runtime behavior.
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

<<<<<<< HEAD
const {
  setRuntime: setMattermostRuntime,
  getRuntime: getMattermostRuntime,
  tryGetRuntime: getOptionalMattermostRuntime,
} = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "mattermost",
  errorMessage: "Mattermost runtime not initialized",
});
export { getMattermostRuntime, getOptionalMattermostRuntime, setMattermostRuntime };
=======
const { setRuntime: setMattermostRuntime, getRuntime: getMattermostRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "mattermost",
    errorMessage: "Mattermost runtime not initialized",
  });
export { getMattermostRuntime, setMattermostRuntime };
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
