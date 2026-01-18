import type { PluginRuntime } from "clawdbot/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setWhatsAppRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getWhatsAppRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("WhatsApp runtime not initialized");
  }
  return runtime;
}
