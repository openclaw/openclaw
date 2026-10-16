import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildCrabboxAllocationArgs,
  type resolveCrabboxProvisionProfile,
} from "./crabbox-worker-profile.js";
import { runProvisionWarmup } from "./crabbox-worker-provision-commands.js";
import {
  type CheckpointContext,
  checkpointCommand,
  parseForkedCheckpoint,
} from "./crabbox-worker-warm-image-checkpoint.js";
import type { CrabboxWarmImagePolicy } from "./crabbox-worker-warm-image-policy.js";
import {
  assertCrabboxWarmImageMigrationReady,
  isCrabboxCaptureRefusalRetained,
  withCrabboxWarmImageGeneration,
  type CrabboxState,
  type WarmAllocationRecord,
  type WarmStartStatus,
  type openCrabboxWarmImageStore,
} from "./crabbox-worker-warm-image-store.js";

export type AllocationContext = CheckpointContext & {
  id: string;
  provider: string;
  reportStartStatus?: (status: WarmStartStatus) => void;
  prepareProject?: boolean;
  profile: ReturnType<typeof resolveCrabboxProvisionProfile>["profile"];
  slug: string;
  projectKey?: string;
  profileId?: string;
  projectLabel?: string;
  projectRoot?: string;
  nodeRuntimeIdentity?: WarmAllocationRecord["runtimeIdentity"];
  preparation?: {
    key: string;
    cacheKey: string;
    purpose: "session" | "reserve";
    demandAtMs: number;
  };
  timeoutMs: () => number;
};

type Store = ReturnType<typeof openCrabboxWarmImageStore>;
type AllocationOwner = NonNullable<Awaited<ReturnType<Store["lookupLease"]>>>;

export function createCrabboxWarmImageAllocation({
  state,
  lookupLease,
  selectAllocation,
  openStore,
  policy,
  assertCurrent,
}: {
  state: CrabboxState;
  lookupLease: Store["lookupLease"];
  selectAllocation: (
    context: AllocationContext,
    profile: AllocationContext["profile"] & { class: string },
  ) => Promise<AllocationOwner>;
  openStore: () => Store;
  policy: CrabboxWarmImagePolicy;
  assertCurrent: (context: CheckpointContext) => void;
}) {
  return async (context: AllocationContext): Promise<WarmAllocationRecord["choice"]> => {
    assertCurrent(context);
    let startStatus: WarmStartStatus = {
      mode: "cold",
      reason:
        context.profile.target !== "linux"
          ? "os-unsupported"
          : !context.profile.class
            ? "class-unknown"
            : "warm-images-off",
      phase: "provisioning",
    };
    if (!context.profile.warmImage) {
      const replay = await lookupLease(context.id);
      if (
        replay &&
        ((replay.os ?? "linux") !== context.profile.target ||
          replay.machineClass !== context.profile.class)
      ) {
        throw new Error(
          "Crabbox provision retry changed its recorded operating system or machine class.",
        );
      }
    }
    if (context.profile.warmImage) {
      await assertCrabboxWarmImageMigrationReady(state);
      const owner = await selectAllocation(context, context.profile);
      const record = await openStore().lookup(owner.key);
      startStatus =
        owner.choice.kind === "checkpoint"
          ? { mode: "snapshot" }
          : {
              mode: "cold",
              reason: owner.coldReason ?? "snapshot-unavailable",
              phase:
                context.prepareProject &&
                owner.phase !== "enrolled" &&
                record &&
                !record.operation &&
                !isCrabboxCaptureRefusalRetained(record, policy.refreshAfterMs) &&
                !(record.image?.pinned && record.previous?.pinned)
                  ? "preparing"
                  : "provisioning",
            };
      context.reportStartStatus?.(startStatus);
      if (owner.choice.kind === "checkpoint") {
        const checkpointId = owner.choice.checkpointId;
        parseForkedCheckpoint(
          await checkpointCommand(
            context,
            "fork",
            [
              "checkpoint",
              "fork",
              checkpointId,
              ...buildCrabboxAllocationArgs(context.profile, context.id, context.slug),
              "--json",
            ],
            context.timeoutMs(),
          ),
          { checkpointId, leaseId: context.id, provider: context.provider, slug: context.slug },
        );
        await openStore().update(owner.key, (current) => {
          assertCurrent(context);
          return withCrabboxWarmImageGeneration(current, owner.imageGeneration, (image) => ({
            ...image,
            state: "available",
            lastDemandAtMs:
              owner.purpose === "session" || owner.demandAtMs === null
                ? image.lastDemandAtMs
                : Math.max(image.lastDemandAtMs ?? 0, owner.demandAtMs),
          }));
        });
        return owner.choice;
      }
    }
    if (!context.profile.warmImage) {
      context.reportStartStatus?.(startStatus);
    }
    assertCurrent(context);
    await runProvisionWarmup(context);
    return { kind: "cold" };
  };
}

export function createCrabboxWarmImageStartContext(
  binary: string,
  provider: string,
  options: Parameters<WorkerProvider["provision"]>[2],
  prepareProject: boolean,
) {
  let status: WarmStartStatus | undefined;
  return {
    binary,
    provider,
    prepareProject,
    reportStartStatus: (next: WarmStartStatus) => {
      status = next;
      options?.reportStartStatus?.(next);
    },
    onCaptureStart: () => {
      if (status) {
        options?.reportStartStatus?.({ ...status, phase: "saving" });
      }
    },
    onCaptureEnd: () => {
      if (status) {
        options?.reportStartStatus?.(status);
      }
    },
  };
}
