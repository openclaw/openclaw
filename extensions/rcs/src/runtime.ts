// Rcs plugin module implements runtime behavior.
import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setRcsRuntime, getRuntime: getRcsRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "rcs",
    errorMessage: "RCS runtime not initialized - plugin not registered",
  });

export { getRcsRuntime, setRcsRuntime };
