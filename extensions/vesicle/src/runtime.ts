import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setVesicleRuntime, getRuntime: getVesicleRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "vesicle",
    errorMessage: "Vesicle runtime not initialized",
  });

export { getVesicleRuntime, setVesicleRuntime };
