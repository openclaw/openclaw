import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "./runtime-api.js";

const { setRuntime: setEmailRuntime, getRuntime: getEmailRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Email runtime not initialized");
export { getEmailRuntime, setEmailRuntime };
export function clearEmailRuntime() {
  setEmailRuntime(undefined as unknown as PluginRuntime);
}
