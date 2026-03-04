import type { PluginRuntime } from "openclaw/plugin-sdk/nextcloud-talk";

let runtime: PluginRuntime | null = null;

export function setNextcloudTalkRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getNextcloudTalkRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Nextcloud Talk runtime not initialized");
  }
  return runtime;
}
