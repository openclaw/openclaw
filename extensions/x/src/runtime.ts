import type { PluginRuntime } from "openclaw/plugin-sdk/x";

let runtime: PluginRuntime | null = null;

export function setXRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getXRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("X runtime not initialized");
  }
  return runtime;
}

export function getXChannel(): any {
  return (getXRuntime().channel as Record<string, unknown>).x as any;
}
