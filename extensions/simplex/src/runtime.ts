import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

let _runtime: OpenClawPluginApi["runtime"] | null = null;

export function setSimplexRuntime(runtime: OpenClawPluginApi["runtime"]) {
  _runtime = runtime;
}

export function getSimplexRuntime(): OpenClawPluginApi["runtime"] {
  if (!_runtime) throw new Error("SimpleX runtime not initialized");
  return _runtime;
}
