import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setEclawRuntime, getRuntime: getEclawRuntime } =
  createPluginRuntimeStore<PluginRuntime>(
    "E-Claw runtime not initialized - plugin not registered",
  );

export { getEclawRuntime, setEclawRuntime };
