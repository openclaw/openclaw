import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setBlueskyRuntime, getRuntime: getBlueskyRuntime } =
  createPluginRuntimeStore<PluginRuntime>(
    "Bluesky runtime not initialized — plugin not registered",
  );

export { getBlueskyRuntime, setBlueskyRuntime };
