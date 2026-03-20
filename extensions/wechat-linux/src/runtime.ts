import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { getRuntime: getWechatLinuxRuntime, setRuntime: setWechatLinuxRuntime } =
  createPluginRuntimeStore<PluginRuntime>("WeChat Linux runtime not initialized");

export { getWechatLinuxRuntime, setWechatLinuxRuntime };
