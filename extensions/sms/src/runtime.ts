import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/sms";

const { setRuntime: setSmsRuntime, getRuntime: getSmsRuntime } =
  createPluginRuntimeStore<PluginRuntime>(
    "SMS runtime not initialized - plugin not registered",
  );
export { getSmsRuntime, setSmsRuntime };
