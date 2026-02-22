import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;
type LegacyRuntimeLogShape = { log?: (message: string) => void };

export function setBlueBubblesRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function clearBlueBubblesRuntime(): void {
  runtime = null;
}

export function tryGetBlueBubblesRuntime(): PluginRuntime | null {
  return runtime;
}

export function getBlueBubblesRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("BlueBubbles runtime not initialized");
  }
  return runtime;
}

export function warnBlueBubbles(message: string): void {
  const formatted = `[bluebubbles] ${message}`;
  // Backward-compatible with tests/legacy injections that pass { log }.
  const log = (runtime as unknown as LegacyRuntimeLogShape | null)?.log;
  if (typeof log === "function") {
    log(formatted);
    return;
  }
  console.warn(formatted);
}
