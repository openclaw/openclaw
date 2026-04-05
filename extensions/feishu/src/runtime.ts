import { createPluginRuntimeStore } from "mullusi/plugin-sdk/runtime-store";
import type { PluginRuntime } from "../runtime-api.js";

const { setRuntime: setFeishuRuntime, getRuntime: getFeishuRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Feishu runtime not initialized");
export { getFeishuRuntime, setFeishuRuntime };
