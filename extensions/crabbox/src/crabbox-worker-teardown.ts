import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { stopCrabboxLease, type LeaseCommandContext } from "./crabbox-worker-command.js";
import type { createCrabboxHeartbeatManager } from "./crabbox-worker-heartbeat.js";
import {
  assertCrabboxLeaseId,
  parseCrabboxCleanupProfile,
  resolveCrabboxWarmImageProfile,
} from "./crabbox-worker-profile.js";
import type { createCrabboxWarmImageManager } from "./crabbox-worker-warm-image.js";

export function createCrabboxWorkerTeardown(dependencies: {
  heartbeats: ReturnType<typeof createCrabboxHeartbeatManager>;
  warmImages: ReturnType<typeof createCrabboxWarmImageManager>;
  providerSignal: AbortSignal;
  warn: (message: string) => void;
  resolveLeaseContext: (lease: Parameters<WorkerProvider["inspect"]>[0]) => Promise<{
    context: LeaseCommandContext;
    profile: ReturnType<typeof parseCrabboxCleanupProfile>;
  }>;
}) {
  const { heartbeats, warmImages, providerSignal, warn, resolveLeaseContext } = dependencies;
  const stopLease = async (
    context: LeaseCommandContext,
    onCleanupAccepted?: () => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    await heartbeats.stop(context.id);
    context.assertCurrent?.();
    // Cleanup has its own deadline. Confirmed stop or absence releases allocation/image ownership.
    await stopCrabboxLease({
      ...context,
      warn,
      onCleanupAccepted,
      signal,
    });
    context.assertCurrent?.();
    await warmImages.release({ ...context, signal });
  };
  return {
    stopLease,
    async destroy(this: void, lease: Parameters<WorkerProvider["destroy"]>[0]): Promise<void> {
      lease.signal?.throwIfAborted();
      assertCrabboxLeaseId(lease.leaseId);
      // An admitted image capture still owns the source. Plain teardown fences
      // renewal immediately; capture transfers it until the waiting stop below.
      if (parseCrabboxCleanupProfile(lease.profile).warmImage === false) {
        await heartbeats.stop(lease.leaseId);
      }
      const { context, profile } = await resolveLeaseContext(lease).catch(
        async (error: unknown) => {
          await heartbeats.stop(lease.leaseId);
          throw error;
        },
      );
      if (lease.resourceReceipt) {
        if (
          !lease.assertCurrent ||
          profile.provider !== lease.resourceReceipt.identity.provider ||
          lease.leaseId !== lease.resourceReceipt.leaseId
        ) {
          throw new Error("Crabbox exact resource teardown authority is unavailable");
        }
        lease.assertCurrent();
        // Receipt-bound Sandbox disks never enter reusable-image capture. The CLI checks
        // its exact claim/resource binding and waits for confirmed deletion.
        await stopLease(
          {
            ...context,
            resourceReceipt: lease.resourceReceipt,
            assertCurrent: lease.assertCurrent,
          },
          undefined,
          lease.signal,
        );
        return;
      }
      let onCleanupAccepted = lease.onCleanupAccepted;
      try {
        const allocation = await warmImages.lookupLease(context.id);
        const captureProfile = resolveCrabboxWarmImageProfile(
          profile,
          allocation?.machineClass ?? profile.class,
          allocation ? (allocation.os ?? "linux") : profile.target,
        );
        if (captureProfile.warmImage) {
          await warmImages.capture({
            ...context,
            signal: lease.signal ? AbortSignal.any([providerSignal, lease.signal]) : providerSignal,
            profile: captureProfile,
            teardown: true,
            onCaptureStart: () => {
              onCleanupAccepted?.();
              onCleanupAccepted = undefined;
            },
          });
        }
      } catch (error) {
        if (lease.signal?.aborted) {
          await heartbeats.stop(context.id);
          lease.signal.throwIfAborted();
        }
        warn(
          `Crabbox warm image capture failed for lease ${context.id}: ${coerceErrorMessage(error)}; next step: crabbox stop --provider ${context.provider} ${context.id}`,
        );
      }
      // A claimed capture releases the reclaim caller through the notification,
      // while the lifecycle owner keeps this promise until stop is confirmed.
      await stopLease(context, onCleanupAccepted, lease.signal);
    },
  };
}
