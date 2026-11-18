import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { crabboxCommandError, leaseRunArgs, runCrabboxCommand } from "./crabbox-worker-command.js";
import { withCrabboxWorkerEnvProfile } from "./crabbox-worker-env-profile.js";
import { createCrabboxNodeRuntimeSetup } from "./crabbox-worker-node-enrollment.js";
import { createCrabboxNodeResumeScript } from "./crabbox-worker-node-process.js";
import { assertCrabboxLeaseId, parseCrabboxProfile } from "./crabbox-worker-profile.js";
import { resolveCrabboxNodeEnrollmentTimeoutMs } from "./crabbox-worker-timeouts.js";

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
    const runtime = request.retainedRuntimeOnly ? undefined : request.runtime;
    const signal = AbortSignal.any([
      request.signal,
      options.signal,
      ...(runtime?.signal ? [runtime.signal] : []),
    ]);
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
    const budgetMs =
      RESUME_WORK_TIMEOUT_MS +
      (runtime ? resolveCrabboxNodeEnrollmentTimeoutMs(runtime.bootstrapTimeoutMs) : 0);
    const deadline = performance.now() + budgetMs;
    const phases = runtime
      ? (["inspect", "prepare", "launch"] as const)
      : (["inspect", "launch"] as const);
    for (const phase of phases) {
      // The read-only identity probe can await runtime startup. Its completion
      // never carries authority into the separately admitted write invocation.
      assertCurrent();
      const timeoutMs = Math.ceil(deadline - performance.now());
      if (timeoutMs <= 0) {
        throw new Error(`Crabbox node resume exceeded its ${budgetMs}ms deadline`);
      }
      const setup =
        phase === "prepare" && runtime
          ? createCrabboxNodeRuntimeSetup({ ...runtime, leaseId: request.leaseId, target: "linux" })
          : {
              command: createCrabboxNodeResumeScript(
                request,
                phase === "inspect" ? "inspect" : "launch",
              ),
              forwardedEnv: undefined,
            };
      const result = await withCrabboxWorkerEnvProfile(
        setup.forwardedEnv,
        (names, profilePath, env) =>
          runCrabboxCommand({
            action: "node resume",
            binary,
            args: [
              ...leaseRunArgs(
                { binary, provider: profile.provider, id: request.leaseId },
                names,
                profilePath,
              ),
              "--no-hydrate",
            ],
            input: setup.command,
            env,
            signal,
            assertCurrent,
            timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())),
            killGraceMs: RESUME_KILL_GRACE_MS,
          }),
      );
      assertCurrent();
      if (result.termination !== "exit" || result.code !== 0) {
        throw crabboxCommandError("node resume", result);
      }
    }
  };
}
