import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  resolveCrabboxWarmImageProfileKey,
  type parseCrabboxProfile,
} from "./crabbox-worker-profile.js";
import {
  resolveCrabboxCheckpointCaptureTimeoutMs,
  WARM_IMAGE_COMMAND_ROUND_TRIP_TIMEOUT_MS,
  WARM_IMAGE_NATIVE_WAIT_TIMEOUT_MS,
} from "./crabbox-worker-timeouts.js";
import {
  CrabboxCheckpointCreateError,
  parseCreatedCheckpoint,
  type CheckpointContext,
  type createCheckpointCommands,
  type parseCheckpointAvailability,
} from "./crabbox-worker-warm-image-checkpoint.js";
import { SCRUB_WORKER_STATE } from "./crabbox-worker-warm-image-scrub.js";
import {
  clearCrabboxWarmImageCapture,
  crabboxWarmImageRecoveryHint,
  withoutCrabboxWarmImageOperation,
  type openCrabboxWarmImageStore,
  type WarmProfileRecord,
} from "./crabbox-worker-warm-image-store.js";

type CrabboxProfile = ReturnType<typeof parseCrabboxProfile>;
type LeaseContext = CheckpointContext & { id: string; provider: string };
type WarmImageStore = ReturnType<typeof openCrabboxWarmImageStore>;

const WARM_IMAGE_REFRESH_MS = 24 * 60 * 60 * 1_000;

export function createCrabboxWarmImageCapture(dependencies: {
  openStore: () => WarmImageStore;
  lookupLease: WarmImageStore["lookupLease"];
  assertCurrent: (context: LeaseContext) => void;
  warnOnce: (action: string, error: unknown) => void;
  collectImages: (context: LeaseContext, phase: "teardown") => Promise<void>;
  verifyImage: (
    context: LeaseContext,
    checkpointId: string,
  ) => Promise<ReturnType<typeof parseCheckpointAvailability>>;
  held: (record: WarmProfileRecord, checkpointId: string) => boolean;
  deleteImage: (context: LeaseContext, key: string, record: WarmProfileRecord) => Promise<void>;
  retireImage: (context: LeaseContext, key: string, record: WarmProfileRecord) => Promise<void>;
  checkpointCommand: ReturnType<typeof createCheckpointCommands>["checkpointCommand"];
  runArgs: (context: LeaseContext) => string[];
}) {
  const {
    openStore,
    lookupLease,
    assertCurrent,
    warnOnce,
    collectImages,
    verifyImage,
    held,
    deleteImage,
    retireImage,
    checkpointCommand,
  } = dependencies;

  return async function capture(
    context: LeaseContext & {
      profile: CrabboxProfile;
      forkedCheckpointId?: string;
      projectCaptureRequired?: true;
    },
    prepareSource?: () => Promise<void>,
  ): Promise<boolean> {
    assertCurrent(context);
    const captureId = randomUUID();
    const owner = lookupLease(context.id);
    const key = owner?.key;
    let claimed = false;
    let creating = false;
    let preparing = false;
    let captured = false;
    const attemptCapture = async () => {
      try {
        await collectImages(context, "teardown");
        if (
          !owner ||
          !key ||
          !owner.runtimeIdentity ||
          owner.demandAtMs === null ||
          (owner.projectKey ? owner.phase !== "prepared" : owner.phase !== "enrolled")
        ) {
          return;
        }
        if (
          (owner.os ?? "linux") !== context.profile.target ||
          key !==
            resolveCrabboxWarmImageProfileKey(
              { ...context.profile, class: owner.machineClass },
              owner.projectKey,
            )
        ) {
          throw new Error("Crabbox capture profile does not match its recorded allocation.");
        }
        let existing = openStore().lookup(key)!;
        if (existing.operation) {
          return;
        }
        if (existing.image) {
          const runtimeMatches = isDeepStrictEqual(
            existing.image.runtimeIdentity,
            owner.runtimeIdentity,
          );
          // A different publication won after this allocation chose its source. An opaque
          // digest is not a newer-version claim; only that source's borrowers may refresh it.
          if (
            (!runtimeMatches ||
              context.projectCaptureRequired ||
              existing.image.preparationKey !== owner.preparationKey ||
              existing.image.cacheKey !== owner.cacheKey) &&
            (owner.choice.kind !== "checkpoint" ||
              owner.choice.checkpointId !== existing.image.checkpointId)
          ) {
            return;
          }
          // The successful fork already attested this image. A concurrently replaced
          // image still needs its own verification before capture or retirement.
          const state =
            context.forkedCheckpointId === existing.image.checkpointId
              ? "available"
              : await verifyImage(context, existing.image.checkpointId);
          if (state === "missing" && !held(existing, existing.image.checkpointId)) {
            await deleteImage(context, key, existing);
            existing = openStore().lookup(key)!;
            if (existing.image || existing.operation) {
              return;
            }
          } else if (
            state !== "missing" &&
            Date.now() - existing.image.createdAtMs < WARM_IMAGE_REFRESH_MS &&
            runtimeMatches &&
            existing.image.preparationKey === owner.preparationKey &&
            existing.image.cacheKey === owner.cacheKey &&
            !context.projectCaptureRequired &&
            (!owner.projectKey || existing.image.baseCommit === owner.baseCommit)
          ) {
            return;
          }
        }
        const now = Date.now();
        assertCurrent(context);
        claimed = openStore().update(key, (current) => {
          if (
            !current ||
            JSON.stringify(current) !== JSON.stringify(existing) ||
            current.allocations[context.id]?.phase !== owner.phase
          ) {
            return undefined;
          }
          return {
            ...current,
            operation: {
              type: "capture",
              id: captureId,
              startedAtMs: now,
              leaseId: context.id,
              provider: context.provider,
              phase: "scrubbing",
            },
          };
        });
        if (!claimed) {
          return;
        }
        // Runtime preparation belongs only to a claimed capture. Scrub its forwarded
        // credential artifacts afterward, before any native image can include them.
        assertCurrent(context);
        preparing = true;
        await prepareSource?.();
        preparing = false;
        await checkpointCommand(
          context,
          "scrub",
          dependencies.runArgs(context),
          WARM_IMAGE_COMMAND_ROUND_TRIP_TIMEOUT_MS,
          SCRUB_WORKER_STATE,
        );
        // A stopped allocation or manual recovery must not start another paid operation.
        assertCurrent(context);
        creating = openStore().update(key, (current) =>
          current?.operation?.type === "capture" &&
          current.operation.id === captureId &&
          current.allocations[context.id]?.phase === owner.phase &&
          current.allocations[context.id]?.machineClass === owner.machineClass &&
          current.allocations[context.id]?.os === owner.os &&
          current.allocations[context.id]?.preparationKey === owner.preparationKey &&
          current.allocations[context.id]?.cacheKey === owner.cacheKey &&
          current.allocations[context.id]?.purpose === owner.purpose
            ? { ...current, operation: { ...current.operation, phase: "creating" } }
            : undefined,
        );
        if (!creating) {
          clearCrabboxWarmImageCapture(key, captureId);
          return;
        }
        const created = parseCreatedCheckpoint(
          await checkpointCommand(
            context,
            "create",
            [
              "checkpoint",
              "create",
              "--provider",
              context.provider,
              "--id",
              context.id,
              "--mode",
              "native",
              // Crabbox owns pending capture recovery; wait for the exact checkpoint
              // before enrollment. Reserve command overhead and separate source recovery too.
              "--wait",
              "--wait-timeout",
              `${WARM_IMAGE_NATIVE_WAIT_TIMEOUT_MS}ms`,
              "--json",
              // Daytona requires explicit permission to stop the scrubbed source for capture.
              ...(context.provider === "daytona" ? ["--no-reboot=false"] : []),
              ...(context.provider === "machine0" ? ["--strategy", "image"] : []),
            ],
            resolveCrabboxCheckpointCaptureTimeoutMs(context.provider),
          ),
          context.id,
        );
        captured = true;
        const published = openStore().update(key, (current) => {
          if (current?.operation?.type !== "capture" || current.operation.id !== captureId) {
            return undefined;
          }
          const next = withoutCrabboxWarmImageOperation(current);
          const allocation = current.allocations[context.id];
          // A late capture still owns its image; it must not recreate a released lease.
          if (
            allocation &&
            allocation.phase === owner.phase &&
            allocation.machineClass === owner.machineClass &&
            allocation.os === owner.os &&
            allocation.preparationKey === owner.preparationKey &&
            allocation.cacheKey === owner.cacheKey &&
            allocation.purpose === owner.purpose &&
            allocation.demandAtMs === owner.demandAtMs
          ) {
            next.allocations = {
              ...next.allocations,
              [context.id]: {
                ...allocation,
                imageGeneration: { checkpointId: created.checkpointId, createdAtMs: now },
              },
            };
          }
          return {
            ...next,
            image: {
              ...created,
              createdAtMs: now,
              preparationKey: owner.preparationKey,
              cacheKey: owner.cacheKey,
              purpose: owner.purpose,
              lastDemandAtMs: owner.purpose === "session" ? null : owner.demandAtMs,
              runtimeIdentity: structuredClone(owner.runtimeIdentity),
              ...(owner.baseCommit ? { baseCommit: owner.baseCommit } : {}),
            },
            ...(current.image && current.image.checkpointId !== created.checkpointId
              ? {
                  operation: {
                    type: "retire" as const,
                    checkpointId: current.image.checkpointId,
                  },
                }
              : {}),
          };
        });
        if (!published) {
          warnOnce(
            "capture ownership changed",
            `Checkpoint ${created.checkpointId} returned after recovery of ${captureId}; reconcile it in the Crabbox catalog before resuming captures.`,
          );
          return;
        }
        creating = false;
        claimed = false;
        const replacement = openStore().lookup(key);
        if (replacement) {
          await retireImage(context, key, replacement);
        }
      } catch (error) {
        const notSubmitted =
          creating && CrabboxCheckpointCreateError.wasNotSubmitted(error, context);
        let recoveryRequired = creating;
        if (claimed && key) {
          try {
            if (creating && !notSubmitted) {
              openStore().update(key, (current) =>
                current?.operation?.type === "capture" && current.operation.id === captureId
                  ? { ...current, operation: { ...current.operation, phase: "uncertain" } }
                  : undefined,
              );
            } else {
              clearCrabboxWarmImageCapture(key, captureId);
              recoveryRequired = false;
            }
          } catch {
            // Keep persisted ownership recoverable; physical lease cleanup still belongs to stop.
          }
        }
        // Required project captures must fail before enrollment. Optional teardown
        // captures can warn and let source deletion complete.
        if (preparing || (notSubmitted && owner?.projectKey)) {
          throw error;
        }
        warnOnce(
          "capture",
          recoveryRequired
            ? `${coerceErrorMessage(error)}. ${crabboxWarmImageRecoveryHint(captureId)}`
            : error,
        );
      }
    };
    await attemptCapture();
    const operation = key && owner?.projectKey ? openStore().lookup(key)?.operation : undefined;
    // A native create may still be running after a lost response. Enrollment must
    // never introduce node credentials into that source until capture has settled.
    if (operation?.type === "capture" && operation.leaseId === context.id) {
      throw new Error(
        `Crabbox project image capture is unresolved. ${crabboxWarmImageRecoveryHint(operation.id)}`,
      );
    }
    assertCurrent(context);
    return captured;
  };
}
