/**
 * Runtime singleton for the Kudosity SMS channel plugin.
 *
 * Stores a reference to the OpenClaw runtime environment, which provides
 * access to config, logging, and other platform services.
 */

import type { RuntimeEnv } from "openclaw/plugin-sdk";

let runtime: RuntimeEnv | undefined;

export function setKudositySmsRuntime(rt: RuntimeEnv): void {
  runtime = rt;
}

export function getKudositySmsRuntime(): RuntimeEnv {
  if (!runtime) {
    throw new Error("Kudosity SMS runtime not initialized — was the plugin registered?");
  }
  return runtime;
}
