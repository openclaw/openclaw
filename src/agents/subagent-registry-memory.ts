import type { SubagentRunRecord } from "./subagent-registry.types.js";

export const subagentRuns = new Map<string, SubagentRunRecord>();

/**
 * Synchronization gate for delegate runs: the cleanup fast path must not
 * delete the child session or remove the run entry until the delegate tool
 * has finished reading the child's output.
 *
 * The delegate tool registers a gate before spawning, and resolves it after
 * `readChildOutput` completes. The lifecycle cleanup fast path awaits the
 * gate (with a bounded timeout) before proceeding with deletion.
 */
type OutputCaptureGate = {
  promise: Promise<void>;
  resolve: () => void;
};

const outputCaptureGates = new Map<string, OutputCaptureGate>();

/** Create a gate that blocks cleanup until output is captured. */
export function registerOutputCaptureGate(runId: string): void {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  outputCaptureGates.set(runId, { promise, resolve });
}

/** Signal that the delegate tool has finished reading the child output. */
export function signalOutputCaptured(runId: string): void {
  const gate = outputCaptureGates.get(runId);
  if (gate) {
    gate.resolve();
    outputCaptureGates.delete(runId);
  }
}

/**
 * Wait for the delegate tool to finish reading the child output, or
 * return after `timeoutMs` to prevent cleanup from stalling indefinitely.
 * Returns `true` if the gate was satisfied, `false` on timeout or no gate.
 */
export async function waitForOutputCaptureGate(runId: string, timeoutMs: number): Promise<boolean> {
  const gate = outputCaptureGates.get(runId);
  if (!gate) {
    return false;
  }
  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs));
  const result = await Promise.race([gate.promise.then(() => "ok" as const), timeout]);
  outputCaptureGates.delete(runId);
  return result === "ok";
}
