/**
 * Open-ClawChat Plugin Runtime
 * Stores the PluginRuntime reference for accessing core functions
 */

import type { PluginRuntime } from "openclaw/plugin-sdk"

let runtime: PluginRuntime | null = null

export function setOpenClawChatRuntime(next: PluginRuntime): void {
  runtime = next
}

export function getOpenClawChatRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Open-ClawChat runtime not initialized")
  }
  return runtime
}
