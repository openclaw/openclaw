import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "../runtime-api.js";

const { setRuntime: setTwitchRuntime, getRuntime: getTwitchRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Twitch runtime not initialized");
export { getTwitchRuntime, setTwitchRuntime };
