import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setCampfireRuntime, getRuntime: getCampfireRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Campfire runtime not initialized");

export { getCampfireRuntime, setCampfireRuntime };
