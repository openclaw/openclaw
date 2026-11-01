import type { WorkerProvider, WorkerLeaseStatus } from "openclaw/plugin-sdk/plugin-entry";
import {
  crabboxCommandOutput,
  runCrabboxCommand,
  type LeaseCommandContext,
} from "./crabbox-worker-command.js";
import type { createCrabboxHeartbeatManager } from "./crabbox-worker-heartbeat.js";
import {
  assertCrabboxLeaseId,
  parseCrabboxCleanupProfile,
  type parseCrabboxProfile,
} from "./crabbox-worker-profile.js";
import type { createCrabboxWorkerBinaryResolver } from "./crabbox-worker-provider-binary.js";
import { inspectWithContext, isNonRunnableState } from "./crabbox-worker-provision-commands.js";
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
  ): Promise<{ context: LeaseHeartbeatContext; profile: CrabboxProfile }> => {
    const profile = parseCrabboxCleanupProfile(lease.profile);
    assertCrabboxLeaseId(lease.leaseId);
    const retention = lease.retention && prepareCrabboxRetention(profile, lease.retention);
    if (retention && (!lease.resourceReceipt || lease.resourceReceipt.leaseId !== lease.leaseId)) {
      throw new Error("Crabbox retained lifecycle requires the original resource receipt");
    }
    return {
      context: {
        binary: (await resolveBinary(profile.binary, lease.signal)).binary,
        heartbeatIntervalMs: profile.heartbeatIntervalMs,
        heartbeatTimeoutMs: profile.heartbeatTimeoutMs,
        id: lease.leaseId,
        idleTimeout: profile.idleTimeout,
        provider: profile.provider,
        ...(retention ? { retention } : {}),
        ...(lease.resourceReceipt ? { resourceReceipt: lease.resourceReceipt } : {}),
      },
      profile,
    };
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
