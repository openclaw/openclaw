import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setTelegramUserbotRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function clearTelegramUserbotRuntime(): void {
  runtime = null;
}

export function tryGetTelegramUserbotRuntime(): PluginRuntime | null {
  return runtime;
}

export function getTelegramUserbotRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("telegram-userbot runtime not initialized");
  }
  return runtime;
}
