import type { RuntimeAPI } from "openclaw/plugin-sdk/runtime-contract";

// Runtime state
let runtimeState: {
  log: typeof console.log;
  error: typeof console.error;
} | null = null;

export const setAgentP2PRuntime: RuntimeAPI = {
  initialize(runtime) {
    runtimeState = {
      log: runtime.log ?? console.log,
      error: runtime.error ?? console.error,
    };
  },
  
  getRuntime() {
    return runtimeState;
  },
};

export function getRuntimeLogger() {
  return runtimeState ?? { log: console.log, error: console.error };
}
