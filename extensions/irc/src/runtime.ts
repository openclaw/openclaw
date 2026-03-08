import { createPluginRuntimeStore } from "openclaw/plugin-sdk";
import type { PluginRuntime } from "openclaw/plugin-sdk/irc";

const { setRuntime: setIrcRuntime, getRuntime: getIrcRuntime } =
  createPluginRuntimeStore<PluginRuntime>("IRC runtime not initialized");
export { getIrcRuntime, setIrcRuntime };
