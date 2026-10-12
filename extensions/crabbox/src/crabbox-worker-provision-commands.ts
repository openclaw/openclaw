import {
  WorkerProviderError,
  type WorkerDesktopEndpoint,
  type WorkerProvider,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  crabboxCommandError,
  crabboxCommandOutput,
  isFixedLeaseIdUnsupported,
  isUnrecognizedLease,
  leaseRunArgs,
  runCrabboxCommand,
  runCrabboxCommandWithCoordinatorRetry,
  type CrabboxCommandRunner,
  type LeaseCommandContext,
} from "./crabbox-worker-command.js";
import {
  createCrabboxWorkerDesktopEndpoint,
  createCrabboxWorkerDesktopSetup,
} from "./crabbox-worker-desktop-setup.js";
import { withCrabboxWorkerEnvProfile } from "./crabbox-worker-env-profile.js";
import { parseInspectJson, type ParsedInspect } from "./crabbox-worker-inspect.js";
import { buildCrabboxAllocationArgs, type parseCrabboxProfile } from "./crabbox-worker-profile.js";
import {
  CRABBOX_LIFECYCLE_TIMEOUT_MS,
  CRABBOX_MACHINE0_READY_WAIT_TIMEOUT,
  CRABBOX_SETUP_TIMEOUT_MS,
  resolveCrabboxLifecycleTimeoutMs,
  resolveCrabboxReadyPollIntervalMs,
} from "./crabbox-worker-timeouts.js";

/** Allocation retains host and project authority independently of cancellation or cleanup. */
export function createCrabboxProvisionAuthority(
  options: Parameters<WorkerProvider["provision"]>[2],
): { signal?: AbortSignal; assertCurrent: () => void } {
  const assertHostCurrent = options?.assertCurrent;
  if (!assertHostCurrent) {
    throw new WorkerProviderError(
      "Crabbox provisioning requires current Gateway allocation authority",
    );
  }
  const signal = options?.signal;
  const project = options?.project;
  const assertCurrent = () => {
    signal?.throwIfAborted();
    assertHostCurrent();
    project?.assertCurrent();
  };
  assertCurrent();
  return { signal, assertCurrent };
}
type ProvisionInspectContext = Omit<LeaseCommandContext, "id"> & {
  deadline: number;
  inspect: ParsedInspect;
  profile: ReturnType<typeof parseCrabboxProfile>;
  runCommand: CrabboxCommandRunner;
  stopLease: (context: LeaseCommandContext) => Promise<void>;
  signal?: AbortSignal;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

// Crabbox states describe lease usability, not proven cleanup: released leases can retain
// resources, and Machine0 maps both DELETING and DELETED to `deleted`. Always stop explicitly.
const NON_RUNNABLE_STATES = new Set([
  "archived",
  "deleted",
  "deleting",
  "destroyed",
  "expired",
  "failed",
  "missing",
  "released",
  "stopped",
  "stopped_with_code",
  "terminated",
]);

export async function inspectWithContext(
  params: LeaseCommandContext & {
    runCommand: CrabboxCommandRunner;
    timeoutMs?: number;
    waitForReady?: boolean;
    signal?: AbortSignal;
    sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  },
): Promise<ParsedInspect | undefined> {
  const action = params.waitForReady ? "status" : "inspect";
  const result = await runCrabboxCommandWithCoordinatorRetry({
    action,
    args: [
      action,
      "--provider",
      params.provider,
      "--network",
      "public",
      "--id",
      params.id,
      ...(params.waitForReady
        ? ["--wait", "--wait-timeout", CRABBOX_MACHINE0_READY_WAIT_TIMEOUT]
        : []),
      "--json",
    ],
    binary: params.binary,
    runCommand: params.runCommand,
    signal: params.signal,
    sleep: params.sleep,
    timeoutMs: params.timeoutMs ?? resolveCrabboxLifecycleTimeoutMs(params.provider),
  });
  if (result.termination === "exit" && result.code === 0) {
    // A successful but malformed response cannot attest the fixed lease. Provision callers
    // must preserve cleanup uncertainty so Gateway replay can inspect the lease later.
    let inspect: ParsedInspect;
    try {
      inspect = parseInspectJson(result.stdout);
    } catch (error) {
      throw new WorkerProviderError(
        error instanceof Error ? error.message : "Crabbox inspect returned invalid output",
      );
    }
    if (inspect.id !== params.id) {
      throw new WorkerProviderError("Crabbox inspect returned a different lease id");
    }
    return inspect;
  }
  if (isUnrecognizedLease(result, params.id, "inspect")) {
    return undefined;
  }
  throw crabboxCommandError(action, result);
}

export function remainingProvisionTimeout(deadline: number, maximum: number): number {
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    throw new Error("Crabbox provision exceeded its provider deadline");
  }
  return Math.min(maximum, remaining);
}

export const isNonRunnableState = (state: string) => NON_RUNNABLE_STATES.has(state.toLowerCase());

export async function runProvisionWarmup(
  params: LeaseCommandContext & {
    profile: ReturnType<typeof parseCrabboxProfile>;
    slug: string;
    runCommand: CrabboxCommandRunner;
    timeoutMs: () => number;
    signal?: AbortSignal;
  },
): Promise<void> {
  const result = await runCrabboxCommand({
    ...params,
    action: "warmup",
    args: ["warmup", ...buildCrabboxAllocationArgs(params.profile, params.id, params.slug)],
    timeoutMs: params.timeoutMs(),
  });
  if (result.termination === "exit" && result.code === 0) {
    return;
  }
  // Crabbox internal/cli/run.go rejects this capability before Warmup/Acquire.
  if (isFixedLeaseIdUnsupported(result, params.provider)) {
    throw new WorkerProviderError(
      `Crabbox backend ${params.provider} does not support fixed lease IDs that are safe to reuse. OpenClaw cloud workers need a Crabbox backend with fixed lease ID support.`,
    );
  }
  const error = crabboxCommandError("warmup", result);
  if (result.termination === "exit" && result.code !== null) {
    try {
      const observed = await inspectWithContext({
        ...params,
        timeoutMs: Math.min(params.timeoutMs(), resolveCrabboxLifecycleTimeoutMs(params.provider)),
      });
      if (observed && isNonRunnableState(observed.state) && observed.failureError) {
        error.message += `; lease failure: ${observed.failureError}`;
      }
    } catch {
      // Inspection only enriches the failure; it cannot change cleanup or replay authority.
      params.signal?.throwIfAborted();
    }
  }
  throw error;
}

function assertProvisionSecurityPolicy(params: { inspect: ParsedInspect; provider: string }): void {
  if (params.inspect.tailscaleEnabled) {
    throw new WorkerProviderError("Crabbox cloud worker lease must not have Tailscale enabled");
  }
  const attached = params.inspect.awsInstanceProfileAttached;
  const pending = !params.inspect.ready && !isNonRunnableState(params.inspect.state);
  if (params.provider === "aws" && attached !== false && (attached || !pending)) {
    throw new WorkerProviderError(
      "Crabbox AWS inspect must attest that no instance profile is attached",
    );
  }
}

export async function waitForProvisionReady(
  params: ProvisionInspectContext & {
    refresh?: boolean;
    sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  },
): Promise<ParsedInspect> {
  let inspect = params.inspect;
  const inspectAgain = async (): Promise<ParsedInspect> => {
    params.signal?.throwIfAborted();
    const replay = await inspectWithContext({
      ...params,
      id: inspect.id,
      timeoutMs: remainingProvisionTimeout(
        params.deadline,
        resolveCrabboxLifecycleTimeoutMs(params.provider),
      ),
      waitForReady: params.provider === "machine0",
    });
    if (!replay) {
      throw new Error("Crabbox operation lease disappeared while waiting for SSH readiness");
    }
    params.signal?.throwIfAborted();
    return replay;
  };
  try {
    inspect = params.refresh ? await inspectAgain() : params.inspect;
    params.signal?.throwIfAborted();
    // Reject forbidden state immediately; omitted AWS metadata is pending only until ready.
    assertProvisionSecurityPolicy({ inspect, provider: params.provider });
    while (inspect.ready !== true && !isNonRunnableState(inspect.state)) {
      params.signal?.throwIfAborted();
      const remaining = remainingProvisionTimeout(params.deadline, CRABBOX_LIFECYCLE_TIMEOUT_MS);
      await params.sleep(
        Math.min(resolveCrabboxReadyPollIntervalMs(params.provider), remaining),
        params.signal,
      );
      params.signal?.throwIfAborted();
      inspect = await inspectAgain();
      assertProvisionSecurityPolicy({ inspect, provider: params.provider });
    }
    if (isNonRunnableState(inspect.state)) {
      throw new WorkerProviderError(
        `Crabbox operation lease entered a terminal state while waiting for SSH${inspect.failureError ? `: ${inspect.failureError}` : ""}`,
      );
    }
    return inspect;
  } catch (error) {
    params.signal?.throwIfAborted();
    if (error instanceof WorkerProviderError) {
      return await failProvisionAfterCleanup({ ...params, id: inspect.id }, error);
    }
    throw error;
  }
}

// Setup runs on every provision attempt (including replay adoption), so commands
// must be idempotent. A failed setup stops the lease before surfacing the error;
// otherwise the caller cannot release a box it never learned about.
export async function runProvisionSetup(
  params: ProvisionInspectContext & {
    phase: string;
    setup: string;
    timeoutMs?: number;
    forwardedEnv?: Record<string, string>;
  },
): Promise<void> {
  try {
    const run =
      params.phase === "profile setup" ||
      params.phase === "node runtime preparation" ||
      params.phase === "node enrollment setup"
        ? runCrabboxCommandWithCoordinatorRetry
        : runCrabboxCommand;
    const result = await withCrabboxWorkerEnvProfile(
      params.forwardedEnv,
      (names, profilePath, childEnv) =>
        run({
          action: params.phase,
          args: leaseRunArgs({ ...params, id: params.inspect.id }, names, profilePath),
          binary: params.binary,
          env: childEnv,
          input: params.setup,
          runCommand: params.runCommand,
          signal: params.signal,
          sleep: params.sleep,
          timeoutMs: remainingProvisionTimeout(
            params.deadline,
            params.timeoutMs ?? CRABBOX_SETUP_TIMEOUT_MS,
          ),
        }),
    );
    crabboxCommandOutput(params.phase, result);
  } catch (error) {
    params.signal?.throwIfAborted();
    return await failProvisionAfterCleanup({ ...params, id: params.inspect.id }, error);
  }
  params.signal?.throwIfAborted();
}

export async function prepareProvisionDesktop(
  params: ProvisionInspectContext & {
    wallpaperBase64: string;
    prepareBeforeEnrollment: boolean;
  },
): Promise<{ setup: string; endpoint: WorkerDesktopEndpoint } | undefined> {
  if (!params.profile.desktop) {
    return undefined;
  }
  let desktop: { setup: string; endpoint: WorkerDesktopEndpoint };
  try {
    const { id, sshUser } = params.inspect;
    desktop = {
      setup: createCrabboxWorkerDesktopSetup(
        id,
        params.wallpaperBase64,
        params.profile.target,
        sshUser,
      ),
      endpoint: createCrabboxWorkerDesktopEndpoint(id, params.profile.target, sshUser),
    };
  } catch (error) {
    params.signal?.throwIfAborted();
    return await failProvisionAfterCleanup({ ...params, id: params.inspect.id }, error);
  }
  if (params.prepareBeforeEnrollment) {
    // Project capture needs the desktop prepared; other leases batch it with enrollment.
    await runProvisionSetup({ ...params, phase: "desktop setup", setup: desktop.setup });
  }
  return desktop;
}

export async function failProvisionAfterCleanup(
  params: LeaseCommandContext & { stopLease: (context: LeaseCommandContext) => Promise<void> },
  provisionError: unknown,
): Promise<never> {
  try {
    await params.stopLease(params);
  } catch (cleanupError) {
    throw WorkerProviderError.cleanupIndeterminate(params.id, provisionError, cleanupError);
  }
  throw WorkerProviderError.cleanupComplete(params.id, provisionError);
}
