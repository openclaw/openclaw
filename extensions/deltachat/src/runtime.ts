import type { PluginRuntime } from "openclaw/plugin-sdk";

interface DeltaChatRuntimeState {
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
}

let deltaChatRuntime: PluginRuntime | null = null;
const state: DeltaChatRuntimeState = {
  lastInboundAt: null,
  lastOutboundAt: null,
  lastStartAt: null,
  lastStopAt: null,
  lastError: null,
};

export function setDeltaChatRuntime(runtime: PluginRuntime): void {
  deltaChatRuntime = runtime;
}

export function getDeltaChatRuntime(): PluginRuntime {
  if (!deltaChatRuntime) {
    throw new Error("Delta.Chat runtime not initialized");
  }
  return deltaChatRuntime;
}

export function updateDeltaChatRuntimeState(partial: Partial<DeltaChatRuntimeState>): void {
  Object.assign(state, partial);
}

export function getDeltaChatRuntimeState(): DeltaChatRuntimeState {
  return state;
}
