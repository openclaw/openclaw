import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { crabboxCommandError, leaseRunArgs, runCrabboxCommand } from "./crabbox-worker-command.js";
import { createCrabboxNodeResumeScript } from "./crabbox-worker-node-process.js";
import { assertCrabboxLeaseId, parseCrabboxProfile } from "./crabbox-worker-profile.js";

// Both ordinary command lifecycles include remote preparation and retirement.
// The caller’s admission signal can end work earlier; cleanup retains custody.
const RESUME_WORK_TIMEOUT_MS = 120_000;
// Let Crabbox finish its 15-second remote cleanup before forcing the local tree.
const RESUME_KILL_GRACE_MS = 20_000;

export function createCrabboxNodeResumer(options: {
  signal: AbortSignal;
  resolveBinary: (binary?: string, signal?: AbortSignal) => Promise<{ binary: string }>;
}): NonNullable<WorkerProvider["resumeNode"]> {
  return async (request) => {
    const signal = AbortSignal.any([request.signal, options.signal]);
    const assertCurrent = () => {
      signal.throwIfAborted();
      request.assertCurrent();
    };
    assertCurrent();
    const profile = parseCrabboxProfile(request.profile);
    // Desktop launchers own their session environment and process receipts.
    if (request.platform !== "linux" || profile.desktop) {
      return;
    }
    assertCrabboxLeaseId(request.leaseId);
    const { binary } = await options.resolveBinary(profile.binary, signal);
    const deadline = performance.now() + RESUME_WORK_TIMEOUT_MS;
    for (const phase of ["inspect", "launch"] as const) {
      // The read-only identity probe can await runtime startup. Its completion
      // never carries authority into the separately admitted write invocation.
      assertCurrent();
      const timeoutMs = Math.ceil(deadline - performance.now());
      if (timeoutMs <= 0) {
        throw new Error(`Crabbox node resume exceeded its ${RESUME_WORK_TIMEOUT_MS}ms deadline`);
      }
      const result = await runCrabboxCommand({
        action: "node resume",
        binary,
        args: [
          ...leaseRunArgs({ binary, provider: profile.provider, id: request.leaseId }),
          "--no-hydrate",
        ],
        input: createCrabboxNodeResumeScript(request, phase),
        signal,
        timeoutMs,
        killGraceMs: RESUME_KILL_GRACE_MS,
      });
      assertCurrent();
      if (result.termination !== "exit" || result.code !== 0) {
        throw crabboxCommandError("node resume", result);
      }
    }
  };
}
