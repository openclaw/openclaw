import type {
  WorkerProvider,
  WorkerLeaseStatus,
  WorkerProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  crabboxCommandOutput,
  runCrabboxCommand,
  type LeaseCommandContext,
} from "./crabbox-worker-command.js";
import { isGatewayAwsGuestReceipt } from "./crabbox-worker-gateway-aws.js";
import type { createCrabboxHeartbeatManager } from "./crabbox-worker-heartbeat.js";
import {
  prepareCrabboxGuestIsolation,
  prepareCrabboxGuestNetwork,
} from "./crabbox-worker-preflight.js";
import {
  assertCrabboxLeaseId,
  parseCrabboxCleanupProfile,
  type parseCrabboxProfile,
} from "./crabbox-worker-profile.js";
import type { createCrabboxWorkerBinaryResolver } from "./crabbox-worker-provider-binary.js";
import { inspectWithContext, isNonRunnableState } from "./crabbox-worker-provision-commands.js";
import { crabboxResourceEnv } from "./crabbox-worker-resource-options.js";
import {
  assertCrabboxResourceReceipt,
  crabboxResourceIdentityArgs,
} from "./crabbox-worker-resource-receipt.js";
import {
  prepareCrabboxRetention,
  assertCrabboxRetentionOperation,
} from "./crabbox-worker-retention.js";
import { CRABBOX_RETENTION_MUTATION_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";

type CrabboxProfile = ReturnType<typeof parseCrabboxProfile>;
type LeaseHeartbeatContext = LeaseCommandContext &
  Pick<CrabboxProfile, "heartbeatIntervalMs" | "heartbeatTimeoutMs" | "idleTimeout">;

/** Lease observation and retained mutations share one exact context and the provider's lifetime. */
export function createCrabboxWorkerLeaseLifecycle(options: {
  resolveBinary: ReturnType<typeof createCrabboxWorkerBinaryResolver>["resolve"];
  heartbeats: ReturnType<typeof createCrabboxHeartbeatManager>;
  signal: AbortSignal;
}) {
  const { resolveBinary, heartbeats } = options;
  const resolveLeaseContext = async (
    lease: Parameters<WorkerProvider["inspect"]>[0],
    requireGuestAccess = true,
  ): Promise<{ context: LeaseHeartbeatContext; profile: CrabboxProfile }> => {
    const profile = parseCrabboxCleanupProfile(lease.profile);
    assertCrabboxLeaseId(lease.leaseId);
    const retention = lease.retention && prepareCrabboxRetention(profile, lease.retention);
    if (retention && (!lease.resourceReceipt || lease.resourceReceipt.leaseId !== lease.leaseId)) {
      throw new Error("Crabbox retained lifecycle requires the original resource receipt");
    }
    const resolvedBinary = await resolveBinary(profile.binary, lease.signal);
    const resolved = {
      context: {
        binary: resolvedBinary.binary,
        heartbeatIntervalMs: profile.heartbeatIntervalMs,
        heartbeatTimeoutMs: profile.heartbeatTimeoutMs,
        id: lease.leaseId,
        ...(lease.untrustedWorkload ? { untrustedWorkload: true as const } : {}),
        idleTimeout: profile.idleTimeout,
        provider: profile.provider,
        env: crabboxResourceEnv(profile.provider, profile.requestedResources),
        ...(retention ? { retention } : {}),
        ...(lease.resourceReceipt ? { resourceReceipt: lease.resourceReceipt } : {}),
      },
      profile,
    };
    // Guest allocation persists this provider-owned receipt before enrollment.
    // It selects mandatory readback even though core passes only provider settings.
    if (
      lease.untrustedWorkload &&
      requireGuestAccess &&
      !isGatewayAwsGuestReceipt(lease.resourceReceipt)
    ) {
      throw new Error("Guest access has no qualified durable launch custody");
    }
    if (isGatewayAwsGuestReceipt(lease.resourceReceipt) && requireGuestAccess) {
      const assertCurrent = () => {
        options.signal.throwIfAborted();
        lease.signal?.throwIfAborted();
      };
      assertCurrent();
      const env = await prepareCrabboxGuestIsolation({
        binary: resolvedBinary.binary,
        cliVersion: resolvedBinary.version,
        provider: profile.provider,
        env: {
          ...resolved.context.env,
          CRABBOX_AWS_REGION: lease.resourceReceipt?.identity.region,
        },
        signal: lease.signal,
        assertCurrent,
      });
      const guestNetwork = await prepareCrabboxGuestNetwork({
        binary: resolved.context.binary,
        provider: profile.provider,
        env,
        resourceReceipt: lease.resourceReceipt,
        signal: lease.signal,
        assertCurrent,
      });
      assertCurrent();
      const context: LeaseHeartbeatContext = {
        ...resolved.context,
        env,
        untrustedWorkload: true,
        guestNetwork,
      };
      const observed = await inspectWithContext({
        ...context,
        signal: lease.signal,
        assertCurrent,
      });
      assertCurrent();
      if (!observed) {
        throw new Error("Crabbox guest network inspection is unavailable");
      }
      return { context, profile };
    }
    return resolved;
  };

  return {
    resolveLeaseContext,
    async inspect(
      this: void,
      lease: Parameters<WorkerProvider["inspect"]>[0],
    ): Promise<WorkerLeaseStatus> {
      const { context } = await resolveLeaseContext(lease);
      const inspected = await inspectWithContext({
        ...context,
        signal: lease.signal,
      });
      lease.signal?.throwIfAborted();
      const receipt = lease.resourceReceipt ? { resourceReceipt: lease.resourceReceipt } : {};
      if (context.retention) {
        await heartbeats.stop(context.id);
        if (!inspected?.retention) {
          throw new Error("Crabbox retained observation is unavailable; ownership preserved");
        }
        return {
          status: inspected.retention.state === "running" ? "active" : "dormant",
          ...(inspected.retention.state === "running" ? { sharedHost: false } : {}),
          ...receipt,
          retention: inspected.retention,
        };
      }
      if (!inspected || isNonRunnableState(inspected.state)) {
        await heartbeats.stop(context.id);
        return { status: "unknown", ...receipt };
      }
      // `ready` is an SSH probe; every recognized nonterminal lease remains active.
      heartbeats.start({ ...context, lifetime: inspected.lifetime });
      return { status: "active", sharedHost: false, ...receipt };
    },
    async setRetainedState(
      this: void,
      lease: Parameters<NonNullable<WorkerProvider["setRetainedState"]>>[0],
    ) {
      lease.assertCurrent();
      assertCrabboxRetentionOperation(lease.operation);
      const operation = Object.freeze({ ...lease.operation });
      const { context } = await resolveLeaseContext(lease);
      const signal = AbortSignal.any([options.signal, ...(lease.signal ? [lease.signal] : [])]);
      const assertCurrent = () => {
        signal.throwIfAborted();
        lease.assertCurrent();
      };
      assertCurrent();
      await heartbeats.stop(context.id);
      const before = await inspectWithContext({ ...context, signal });
      assertCurrent();
      assertCrabboxResourceReceipt(lease.resourceReceipt, before?.resourceReceipt);
      const retention = context.retention;
      if (!retention || before?.retention?.state === "unavailable") {
        throw new Error("Crabbox retained ownership is unavailable; operation preserved");
      }
      const previous = before?.retention;
      const replay = previous?.operation?.id === operation.id;
      if (
        !previous ||
        (replay
          ? previous.operation?.action !== operation.action ||
            previous.operation.expectedClaimRevision !== operation.expectedClaimRevision
          : previous.claimRevision !== operation.expectedClaimRevision ||
            previous.operation?.phase === "pending")
      ) {
        throw new Error(
          "Crabbox retained lifecycle revision or operation changed; inspect before retrying",
        );
      }
      const result = await runCrabboxCommand({
        binary: context.binary,
        action: operation.action,
        args: [
          operation.action,
          "--provider",
          context.provider,
          "--id",
          context.id,
          "--operation-id",
          operation.id,
          "--owner-binding",
          retention.ownerBinding,
          "--expected-claim-revision",
          operation.expectedClaimRevision,
          ...crabboxResourceIdentityArgs(lease.resourceReceipt),
          "--json",
        ],
        timeoutMs: CRABBOX_RETENTION_MUTATION_TIMEOUT_MS,
        signal,
        assertCurrent,
      });
      assertCurrent();
      // Do not trust the mutation reply as completion. A failed/lost reply leaves the
      // caller-owned operation intact; replay submits those exact same preconditions.
      crabboxCommandOutput(operation.action, { ...result, stdout: "" });
      const after = await inspectWithContext({ ...context, signal });
      assertCurrent();
      assertCrabboxResourceReceipt(lease.resourceReceipt, after?.resourceReceipt);
      const observed = after?.retention;
      if (
        !observed ||
        observed.operation?.id !== operation.id ||
        observed.operation.action !== operation.action ||
        observed.operation.expectedClaimRevision !== operation.expectedClaimRevision ||
        observed.operation.phase !== "observed" ||
        observed.state !== (operation.action === "pause" ? "suspended" : "running")
      ) {
        throw new Error(
          "Crabbox retained lifecycle readback remains uncertain; preserve and retry the same operation",
        );
      }
      return observed;
    },
  };
}

/** Coalesce maintenance without tying lease cleanup to a provision request. */
export function createCrabboxWorkerMaintenance(params: {
  signal: AbortSignal;
  resolveBinaries: (profiles: readonly WorkerProfile[], signal: AbortSignal) => Promise<string[]>;
  maintainImages: (params: {
    binaries: string[];
    signal: AbortSignal;
    assertCurrent: () => void;
  }) => Promise<void>;
}) {
  let maintenanceInFlight: Promise<void> | undefined;
  const maintain: NonNullable<WorkerProvider["maintain"]> = (context) => {
    context.assertCurrent();
    params.signal.throwIfAborted();
    return (maintenanceInFlight ??= Promise.resolve()
      .then(async () => {
        const signal = AbortSignal.any([context.signal, params.signal]);
        const assertCurrent = () => {
          signal.throwIfAborted();
          context.assertCurrent();
        };
        assertCurrent();
        // Records have no binary owner: try sorted executables until deletion or all report absent.
        // Crabbox prints `checkpoint absent id=<id>` with exit 0 (internal/cli/checkpoint.go).
        const resolvedBinaries = await params.resolveBinaries(context.profiles, signal);
        assertCurrent();
        await params.maintainImages({
          binaries: resolvedBinaries,
          signal,
          assertCurrent,
        });
      })
      .finally(() => {
        maintenanceInFlight = undefined;
      }));
  };
  return { maintain, settle: () => maintenanceInFlight?.catch(() => {}) };
}
