import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setYuanbaoRuntime, getRuntime: getYuanbaoRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Yuanbao runtime not initialized");
export { getYuanbaoRuntime, setYuanbaoRuntime };
