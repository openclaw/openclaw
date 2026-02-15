import type { PluginRuntime } from "clawdbot/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setRuntime(next: PluginRuntime): void {
    runtime = next;
}

export function getRuntime(): PluginRuntime {
    if (!runtime) {
        throw new Error("WeChat runtime not initialized");
    }
    return runtime;
}
