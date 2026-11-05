import { setTimeout as delay } from "node:timers/promises";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
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
  sanitizeCrabboxNotice,
  type LeaseCommandContext,
} from "./crabbox-worker-command.js";
import {
  createCrabboxWorkerDesktopEndpoint,
  createCrabboxWorkerDesktopSetup,
} from "./crabbox-worker-desktop-setup.js";
import { withCrabboxWorkerEnvProfile } from "./crabbox-worker-env-profile.js";
import { parseInspectJson, type ParsedInspect } from "./crabbox-worker-inspect.js";
import { buildCrabboxAllocationArgs, type parseCrabboxProfile } from "./crabbox-worker-profile.js";
import { assertCrabboxResourceReceipt } from "./crabbox-worker-resource-receipt.js";
import { runCrabboxSetupEgress } from "./crabbox-worker-setup-egress.js";
import {
  CRABBOX_LIFECYCLE_TIMEOUT_MS,
  CRABBOX_MACHINE0_READY_WAIT_TIMEOUT,
  CRABBOX_SETUP_TIMEOUT_MS,
  resolveCrabboxLifecycleTimeoutMs,
  resolveCrabboxReadyPollIntervalMs,
} from "./crabbox-worker-timeouts.js";

const bootstrapLog = createSubsystemLogger("gateway/worker-environments");

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
  stopLease: (context: LeaseCommandContext) => Promise<void>;
  signal?: AbortSignal;
};

// Crabbox states describe lease usability, not proven cleanup: released leases can retain
// resources, and Machine0 maps both DELETING and DELETED to `deleted`. Always stop explicitly.
const NON_RUNNABLE_STATES = new Set([
  "archived",
  "cleanup",
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
    timeoutMs?: number;
    waitForReady?: boolean;
    requireConfirmedAbsence?: boolean;
    /** Only receipt-bound stop may continue to its own independent deletion confirmation. */
    exactTeardown?: true;
    signal?: AbortSignal;
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
    signal: params.signal,
    timeoutMs: params.timeoutMs ?? resolveCrabboxLifecycleTimeoutMs(params.provider),
  });
  if (result.termination === "exit" && result.code === 0) {
    // A successful but malformed response cannot attest the fixed lease. Provision callers
    // must preserve cleanup uncertainty so Gateway replay can inspect the lease later.
    let inspect: ParsedInspect;
    try {
      inspect = parseInspectJson(result.stdout, params.retention, params.resourceReceipt);
      const notice = sanitizeCrabboxNotice(result.stderr);
      if (notice) {
        inspect.lifetime = { ...inspect.lifetime, policyNotice: notice };
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Crabbox inspect returned invalid output";
      if (params.resourceReceipt || params.retention) {
        throw new Error(message, { cause: error });
      }
      throw new WorkerProviderError(message);
    }
    if (
      params.resourceReceipt &&
      (!params.retention || inspect.resourceReceipt || inspect.retention?.state === "running")
    ) {
      assertCrabboxResourceReceipt(params.resourceReceipt, inspect.resourceReceipt);
    }
    if (inspect.id !== params.id) {
      throw new WorkerProviderError("Crabbox inspect returned a different lease id");
    }
    return inspect;
  }
  // Ordinary callers accept lost-custody diagnostics; reconciliation requires
  // provider-absence proof. Gateway teardown still verifies cleanup through stop.
  const unavailableResource =
    result.termination === "exit" &&
    result.stdout.trim() === "" &&
    ((params.provider === "digitalocean" &&
      result.code === 4 &&
      result.stderr.trim() === "DigitalOcean fixed lease is terminal") ||
      (params.provider === "ascii-box" &&
        result.code === 1 &&
        /^ascii-box bx_[A-Za-z0-9_-]+ not found \(404\)$/u.test(result.stderr.trim())));
  if (
    (unavailableResource && !params.requireConfirmedAbsence) ||
    isUnrecognizedLease(result, params.id, "inspect", params.requireConfirmedAbsence)
  ) {
    if (params.resourceReceipt && params.exactTeardown) {
      return undefined;
    }
    if (params.resourceReceipt || params.retention) {
      throw new Error("Crabbox resource observation is unavailable; ownership preserved");
    }
    return undefined;
  }
  // An inspect response may contain connection material, even on a failed
  // command. Diagnostics must never echo that JSON back to the caller.
  throw crabboxCommandError(action, {
    ...result,
    stdout: /^\s*[[{]/u.test(result.stdout) ? "" : result.stdout,
  });
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
    timeoutMs: () => number;
    signal?: AbortSignal;
  },
): Promise<void> {
  const result = await runCrabboxCommand({
    ...params,
    action: "warmup",
    args: [
      "warmup",
      ...buildCrabboxAllocationArgs(params.profile, params.id, params.slug, params.retention),
    ],
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
      // A readiness probe may lag valid allocation. Poll without changing compute;
      // a closed window still needs an explicitly authorized lifecycle operation.
      if (
        params.retention &&
        (inspect.retention?.state === "expired" || inspect.retention?.state === "suspended")
      ) {
        throw new Error("Crabbox retained compute needs explicit lifecycle recovery");
      }
      params.signal?.throwIfAborted();
      const remaining = remainingProvisionTimeout(params.deadline, CRABBOX_LIFECYCLE_TIMEOUT_MS);
      await delay(
        Math.min(resolveCrabboxReadyPollIntervalMs(params.provider), remaining),
        undefined,
        { signal: params.signal },
      );
      params.signal?.throwIfAborted();
      inspect = await inspectAgain();
      assertProvisionSecurityPolicy({ inspect, provider: params.provider });
    }
    if (params.retention && inspect.retention?.state !== "running") {
      throw new Error(
        "Crabbox retained compute is not running; explicit lifecycle recovery required",
      );
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
    assertCurrent?: () => void;
  },
): Promise<void> {
  try {
    const run =
      params.phase === "profile setup" ||
      params.phase === "node runtime preparation" ||
      params.phase === "node enrollment setup"
        ? runCrabboxCommandWithCoordinatorRetry
        : runCrabboxCommand;
    const result =
      params.phase === "profile setup" && Object.keys(params.profile.setupSecrets ?? {}).length
        ? await runCrabboxSetupEgress({
            ...params,
            id: params.inspect.id,
            secrets: params.profile.setupSecrets ?? {},
            createScript: () => params.setup,
            assertCurrent: () => {
              params.signal?.throwIfAborted();
              if (!params.assertCurrent) {
                throw new Error("Setup secrets require current provisioning authority");
              }
              params.assertCurrent();
            },
            timeoutMs: remainingProvisionTimeout(
              params.deadline,
              params.timeoutMs ?? CRABBOX_SETUP_TIMEOUT_MS,
            ),
          })
        : await withCrabboxWorkerEnvProfile(params.forwardedEnv, (names, profilePath, childEnv) =>
            run({
              action: params.phase,
              args: leaseRunArgs({ ...params, id: params.inspect.id }, names, profilePath),
              binary: params.binary,
              env: childEnv,
              input: params.setup,
              signal: params.signal,
              timeoutMs: remainingProvisionTimeout(
                params.deadline,
                params.timeoutMs ?? CRABBOX_SETUP_TIMEOUT_MS,
              ),
            }),
          );
    crabboxCommandOutput(params.phase, result);
    const output = `${result.stdout}\n${result.stderr}`;
    for (const match of output.matchAll(
      /^CRABBOX_TIMING:(openclaw-bootstrap-[a-z-]+):(\d+)\r?$/gmu,
    )) {
      bootstrapLog.info(`Cloud worker ${params.inspect.id}: ${match[1]} ${match[2]}ms`);
    }
    for (const match of output.matchAll(
      /^CRABBOX_WARNING:openclaw-bootstrap-unlocked-install:([a-zA-Z0-9 _-]+)\r?$/gmu,
    )) {
      bootstrapLog.warn(
        `Cloud worker ${params.inspect.id}: using unlocked runtime install (${match[1]})`,
      );
    }
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
