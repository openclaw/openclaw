/**
 * Runtime singleton for the Kudosity SMS channel plugin.
 *
 * Stores a reference to the OpenClaw runtime environment, which provides
 * access to config, logging, and other platform services.
 */

import type { PluginRuntime } from "openclaw/plugin-sdk/kudosity-sms";

let runtime: PluginRuntime | undefined;

export function setKudositySmsRuntime(rt: PluginRuntime): void {
  runtime = rt;
}

export function getKudositySmsRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Kudosity SMS runtime not initialized — was the plugin registered?");
  }
  return runtime;
}
