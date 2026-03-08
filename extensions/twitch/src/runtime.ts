import { createPluginRuntimeStore } from "openclaw/plugin-sdk";
import type { PluginRuntime } from "openclaw/plugin-sdk/twitch";

const { setRuntime: setTwitchRuntime, getRuntime: getTwitchRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Twitch runtime not initialized");
export { getTwitchRuntime, setTwitchRuntime };
