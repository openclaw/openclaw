/**
 * Runtime module for zalouser-free
 * Provides access to OpenClaw PluginRuntime
 */

import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setZalouserFreeRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getZalouserFreeRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Zalouser-free runtime not initialized");
  }
  return runtime;
}

export function hasZalouserFreeRuntime(): boolean {
  return runtime !== null;
}
