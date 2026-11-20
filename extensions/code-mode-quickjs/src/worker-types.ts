import type { CodeModeWorkerPayload } from "openclaw/plugin-sdk/code-mode-executor-runtime";
import type { Snapshot } from "quickjs-wasi";

export type QuickJsDeterministicState = {
  startedAt: number;
  timeMs: number;
  fingerprint: string;
};

/** Process-local snapshot metadata, never a durable JavaScript stack. */
export type QuickJsSnapshot = Snapshot & { deterministic?: QuickJsDeterministicState };

export type QuickJsWorkerPayload = CodeModeWorkerPayload<QuickJsSnapshot> & {
  wasmModule: WebAssembly.Module;
  wasmExtensions: Array<{ name: string; wasm: WebAssembly.Module }>;
  engineFingerprint: string;
};
