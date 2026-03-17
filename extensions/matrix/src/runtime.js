import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
const { setRuntime: setMatrixRuntime, getRuntime: getMatrixRuntime } = createPluginRuntimeStore("Matrix runtime not initialized");
export {
  getMatrixRuntime,
  setMatrixRuntime
};
