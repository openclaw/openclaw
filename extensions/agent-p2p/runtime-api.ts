// Runtime state
let runtimeState: {
  log: typeof console.log;
  error: typeof console.error;
} | null = null;

export const setAgentP2PRuntime = {
  initialize(runtime: { log?: typeof console.log; error?: typeof console.error }) {
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
