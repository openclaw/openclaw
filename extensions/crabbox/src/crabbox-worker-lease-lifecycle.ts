import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  crabboxCommandError,
  runCrabboxCommand,
  leaseRunArgs,
  type CrabboxCommandRunner,
  type LeaseCommandContext,
} from "./crabbox-worker-command.js";
import type { createCrabboxHeartbeatManager } from "./crabbox-worker-heartbeat.js";
import { createCrabboxNodeEnrollmentSetup } from "./crabbox-worker-node-enrollment.js";
import {
  parseCrabboxProfile,
  resolveCrabboxWarmImageProfile,
  assertCrabboxLeaseId,
  operationLeaseId,
  operationSlug,
} from "./crabbox-worker-profile.js";
import { inspectWithContext, isNonRunnableState } from "./crabbox-worker-provision-commands.js";
import {
  resolveCrabboxLifecycleTimeoutMs,
  resolveCrabboxNodeEnrollmentTimeoutMs,
} from "./crabbox-worker-timeouts.js";
import type { createCrabboxWarmImageManager } from "./crabbox-worker-warm-image.js";

type LeaseHeartbeatContext = LeaseCommandContext &
  Parameters<ReturnType<typeof createCrabboxHeartbeatManager>["start"]>[0];

const CRABBOX_FAILED_LEASE_HOLD_TIMEOUT_MS = 10 * 60_000;

type WorkerLeaseRecoveryHold = Awaited<ReturnType<NonNullable<WorkerProvider["holdFailedLease"]>>>;

function parseCrabboxRecoveryHold(raw: string, leaseId: string): WorkerLeaseRecoveryHold {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Crabbox failed-lease hold returned invalid JSON");
  }
  if (
    !isRecord(value) ||
    value.schema !== "crabbox.lease-hold.v1" ||
    value.provider !== "azure" ||
    value.status !== "held" ||
    value.leaseId !== leaseId ||
    value.unacceptedChanges !== "unknown" ||
    !Array.isArray(value.resources) ||
    value.resources.length !== 5
  ) {
    throw new Error("Crabbox did not return an exact failed-lease hold receipt");
  }
  const kinds = new Set(["vm", "nic", "public-ip", "disk", "nsg"]);
  const resources = value.resources.map<WorkerLeaseRecoveryHold["resources"][number]>(
    (entry: unknown) => {
      if (
        !isRecord(entry) ||
        typeof entry.kind !== "string" ||
        !kinds.delete(entry.kind) ||
        typeof entry.id !== "string" ||
        !entry.id.startsWith("/subscriptions/") ||
        (entry.state !== "absent" && entry.state !== "retained") ||
        (entry.kind === "vm" && entry.state !== "absent") ||
        (entry.state === "retained" &&
          (typeof entry.immutableId !== "string" || !entry.immutableId.trim()))
      ) {
        throw new Error("Crabbox retained-resource identity is invalid");
      }
      const resource: WorkerLeaseRecoveryHold["resources"][number] = {
        kind: entry.kind,
        id: entry.id,
        state: entry.state,
      };
      if (typeof entry.immutableId === "string") {
        resource.immutableId = entry.immutableId;
      }
      return resource;
    },
  );
  return { status: "held", leaseId, unacceptedChanges: "unknown", resources };
}

export function createCrabboxWorkerLeaseLifecycle(options: {
  runCommand: CrabboxCommandRunner;
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  warmImages: Pick<ReturnType<typeof createCrabboxWarmImageManager>, "lookupLease" | "capture">;
  stopLease: (context: LeaseCommandContext) => Promise<void>;
  warn: (message: string) => void;
  signal: AbortSignal;
  heartbeats: Pick<ReturnType<typeof createCrabboxHeartbeatManager>, "start" | "stop">;
  resolveLeaseContext: (
    lease: Parameters<WorkerProvider["inspect"]>[0],
  ) => Promise<{ context: LeaseHeartbeatContext; profile: ReturnType<typeof parseCrabboxProfile> }>;
}): Pick<WorkerProvider, "inspect" | "resume" | "destroy" | "holdFailedLease"> {
  return {
    async inspect(lease) {
      const { context } = await options.resolveLeaseContext(lease);
      const inspected = await inspectWithContext({
        ...context,
        runCommand: options.runCommand,
        sleep: options.sleep,
      });
      if (
        context.provider === "azure-sandbox" &&
        inspected &&
        ["stopped", "suspended", "idle", "resuming", "stopping", "suspending"].includes(
          inspected.state.toLowerCase(),
        )
      ) {
        await options.heartbeats.stop(context.id);
        return { status: "dormant" };
      }
      if (!inspected || isNonRunnableState(inspected.state)) {
        await options.heartbeats.stop(context.id);
        return { status: "unknown" };
      }
      if (
        context.provider === "azure-sandbox" &&
        !["running", "creating", "starting"].includes(inspected.state.toLowerCase())
      ) {
        await options.heartbeats.stop(context.id);
        return { status: "unknown" };
      }
      // SSH readiness is separate from the provider's live lease identity.
      options.heartbeats.start(context);
      return { status: "active", sharedHost: false };
    },
    async resume(lease, authority) {
      authority.assertCurrent();
      authority.signal.throwIfAborted();
      const { context, profile } = await options.resolveLeaseContext(lease);
      authority.assertCurrent();
      if (context.provider !== "azure-sandbox") {
        return "unsupported";
      }
      if (!authority.beginNodeEnrollment) {
        throw new Error("Sandbox resumption requires its existing node enrollment owner");
      }
      const signal = AbortSignal.any([authority.signal, options.signal]);
      const run = async (
        input: string,
        env?: Record<string, string>,
        timeoutMs = resolveCrabboxLifecycleTimeoutMs(context.provider),
        phaseSignal = signal,
      ) => {
        phaseSignal.throwIfAborted();
        authority.assertCurrent();
        const result = await runCrabboxCommand({
          ...context,
          action: "run",
          args: leaseRunArgs(context, Object.keys(env ?? {})),
          runCommand: options.runCommand,
          input,
          env,
          timeoutMs,
          signal: phaseSignal,
        });
        authority.assertCurrent();
        phaseSignal.throwIfAborted();
        if (result.termination !== "exit" || result.code !== 0) {
          throw crabboxCommandError("resume", result);
        }
      };
      // The existing exact-ID execution owner checks disabled/expiry/deleting
      // and lease ownership; this command neither allocates nor renews the TTL.
      const enrollment = await authority.beginNodeEnrollment();
      authority.assertCurrent();
      if (enrollment.mode !== "resume") {
        throw new Error("Sandbox resumption cannot create another node identity");
      }
      await run("true\n");
      const setup = createCrabboxNodeEnrollmentSetup({
        enrollment,
        leaseId: context.id,
        target: profile.target,
      });
      await run(
        setup.command,
        setup.forwardedEnv,
        resolveCrabboxNodeEnrollmentTimeoutMs(enrollment.bootstrapTimeoutMs),
        enrollment.signal ? AbortSignal.any([signal, enrollment.signal]) : signal,
      );
      if ((await enrollment.waitForDeviceId()) !== enrollment.deviceId) {
        throw new Error("Sandbox resumption returned another node identity");
      }
      authority.assertCurrent();
      signal.throwIfAborted();
      return "resumed";
    },
    async destroy(lease): Promise<void> {
      assertCrabboxLeaseId(lease.leaseId);
      // Stop renewal before binary acquisition can delay or fail teardown.
      await options.heartbeats.stop(lease.leaseId);
      const { context, profile } = await options.resolveLeaseContext(lease);
      // Lifecycle profiles omit placement overrides. Successful enrollment records
      // the class and OS that own the warm policy and reusable image after restart.
      let captureError: unknown;
      try {
        const allocation =
          profile.warmImage === false
            ? undefined
            : await options.warmImages.lookupLease(context.id);
        const captureProfile = resolveCrabboxWarmImageProfile(
          profile,
          allocation?.machineClass ?? profile.class,
          allocation ? (allocation.os ?? "linux") : profile.target,
        );
        if (captureProfile.warmImage) {
          await options.warmImages.capture({ ...context, profile: captureProfile });
        }
      } catch (error) {
        captureError = error;
      }
      await options.stopLease(context);
      if (captureError) {
        // Capture recovery remains recorded separately from confirmed source cleanup.
        options.warn(
          `Crabbox warm image capture failed during teardown: ${coerceErrorMessage(captureError)}`,
        );
      }
    },
    async holdFailedLease(lease, authority) {
      if (
        lease.operationId !== undefined &&
        operationLeaseId(lease.operationId) !== lease.leaseId
      ) {
        throw new Error("Crabbox hold operation differs from its original fixed lease");
      }
      const signal = authority.signal
        ? AbortSignal.any([authority.signal, options.signal])
        : options.signal;
      signal.throwIfAborted();
      authority.assertCurrent();
      await options.heartbeats.stop(lease.leaseId);
      const { context } = await options.resolveLeaseContext(lease);
      authority.assertCurrent();
      signal.throwIfAborted();
      if (context.provider !== "azure") {
        throw new Error("Crabbox failed-lease holds currently require the Azure provider");
      }
      const result = await runCrabboxCommand({
        binary: context.binary,
        runCommand: options.runCommand,
        action: "hold",
        args: [
          "hold",
          "--provider",
          context.provider,
          "--id",
          context.id,
          ...(lease.operationId ? ["--slug", operationSlug(lease.operationId)] : []),
          "--json",
        ],
        timeoutMs: CRABBOX_FAILED_LEASE_HOLD_TIMEOUT_MS,
        signal,
      });
      authority.assertCurrent();
      if (result.termination !== "exit" || result.code !== 0) {
        throw crabboxCommandError("hold", result);
      }
      return parseCrabboxRecoveryHold(result.stdout, context.id);
    },
  };
}
