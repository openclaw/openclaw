import { createPluginRuntimeStore } from "openclaw/plugin-sdk";
import type { PluginRuntime } from "openclaw/plugin-sdk/matrix";

const { setRuntime: setMatrixRuntime, getRuntime: getMatrixRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Matrix runtime not initialized");
export { getMatrixRuntime, setMatrixRuntime };
