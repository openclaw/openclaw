import type { PluginRuntime } from "openclaw/plugin-sdk";

// oxlint-disable-next-line typescript-eslint/no-redundant-type-constituents -- PluginRuntime is correctly typed via plugin-sdk
let runtime: PluginRuntime | null = null;

export function setPlatformChannelRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getPlatformChannelRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("PlatformChannel runtime not initialized");
  }
  return runtime;
}
