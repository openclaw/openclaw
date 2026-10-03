import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { leaseRunArgs } from "./crabbox-worker-command.js";
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
  assertCrabboxCheckpointCurrent as assertCurrent,
  captureCrabboxCheckpointAuthority,
  CrabboxCheckpointCreateError,
  parseCreatedCheckpoint,
  type CheckpointContext,
  type createCheckpointCommands,
  type parseCheckpointAvailability,
} from "./crabbox-worker-warm-image-checkpoint.js";
import type { CrabboxWarmImagePolicy } from "./crabbox-worker-warm-image-policy.js";
import { SCRUB_WORKER_STATE } from "./crabbox-worker-warm-image-scrub.js";
import {
  clearCrabboxWarmImageCapture,
  crabboxCaptureUnsupportedSentence,
  crabboxWarmImageRecoveryHint,
  sameCrabboxWarmImageGeneration,
  withoutCrabboxWarmImageOperation,
  type openCrabboxWarmImageStore,
  type WarmProfileRecord,
} from "./crabbox-worker-warm-image-store.js";

type CrabboxProfile = ReturnType<typeof parseCrabboxProfile>;
type LeaseContext = CheckpointContext & { id: string; provider: string };
type WarmImageStore = ReturnType<typeof openCrabboxWarmImageStore>;

export function createCrabboxWarmImageCapture(dependencies: {
  policy: CrabboxWarmImagePolicy;
  openStore: () => WarmImageStore;
  lookupLease: WarmImageStore["lookupLease"];
  warnOnce: (action: string, error: unknown, failed?: boolean) => void;
  collectProfileImages: (context: LeaseContext, key: string, phase: "teardown") => Promise<void>;
  verifyImage: (
    context: LeaseContext,
    checkpointId: string,
  ) => Promise<ReturnType<typeof parseCheckpointAvailability>>;
  held: (record: WarmProfileRecord, checkpointId: string) => boolean;
  deleteImage: (context: LeaseContext, key: string, record: WarmProfileRecord) => Promise<void>;
  retireImage: (context: LeaseContext, key: string, record: WarmProfileRecord) => Promise<void>;
  checkpointCommand: ReturnType<typeof createCheckpointCommands>["checkpointCommand"];
}) {
  const {
    openStore,
    lookupLease,
    warnOnce,
    collectProfileImages,
    verifyImage,
    held,
    deleteImage,
    retireImage,
    checkpointCommand,
  } = dependencies;
  const warnUnsupported = (message: string) =>
    warnOnce(
      "capture unsupported",
      `${crabboxCaptureUnsupportedSentence(message)} Workers for this profile use an existing compatible snapshot when one is available and otherwise provision cold; each eligible worker retries capture, so Crabbox configuration changes apply to the next dispatch. Set settings.warmImage: false on the profile to stop capture attempts.`,
      false,
    );

  return async function capture(
    context: LeaseContext & {
      profile: CrabboxProfile;
      forkedCheckpointId?: string;
      projectCaptureRequired?: true;
      projectCaptureReplay?: true;
    },
    prepareAndScrubSource?: (scrubScript: string) => Promise<void>,
  ): Promise<boolean> {
    assertCurrent(context);
    const assertSourceCurrent = context.assertCurrent;
    const authority = captureCrabboxCheckpointAuthority(context);
    const captureId = randomUUID();
    const owner = await lookupLease(context.id);
    const key = owner?.key;
    let pendingCapture = false;
    let createDispatched = false;
    let preparing = false;
    let createdCheckpointId: string | undefined;
    const attemptCapture = async () => {
      try {
        if (key) {
          await collectProfileImages(context, key, "teardown");
        }
        if (
          !owner ||
          !key ||
          !owner.runtimeIdentity ||
          owner.demandAtMs === null ||
          // Teardown retains cleanup custody, not authority to start a project capture.
          (owner.projectKey
            ? owner.phase !== "prepared" || !assertSourceCurrent
            : owner.phase !== "enrolled")
        ) {
          return undefined;
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
        let existing = (await openStore().lookup(key))!;
        if (existing.operation) {
          return undefined;
        }
        if (existing.image?.pinned && existing.previous?.pinned) {
          warnOnce(
            "capture paused",
            "The current and previous snapshots are pinned; unpin one before publishing another generation.",
          );
          return undefined;
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
              owner.choice.checkpointId !== existing.image.checkpointId) &&
            // A pinned incompatible base remains owned, but does not prevent a newly
            // admitted cold preparation from publishing a compatible successor.
            !(
              owner.choice.kind === "cold" &&
              sameCrabboxWarmImageGeneration(owner.publicationBase, existing.image)
            )
          ) {
            return undefined;
          }
          // The successful fork already attested this image. A concurrently replaced
          // image still needs its own verification before capture or retirement.
          const state =
            context.forkedCheckpointId === existing.image.checkpointId
              ? "available"
              : await verifyImage(context, existing.image.checkpointId);
          // Foreground sessions use the refreshed checkout immediately. A reserve
          // can publish that commit without making the session wait for a snapshot.
          if (
            state === "available" &&
            owner.purpose === "session" &&
            !context.projectCaptureReplay &&
            owner.choice.kind === "checkpoint" &&
            owner.choice.checkpointId === existing.image.checkpointId &&
            context.forkedCheckpointId === existing.image.checkpointId &&
            (existing.image.pinned ||
              Date.now() - existing.image.createdAtMs < dependencies.policy.refreshAfterMs) &&
            owner.cacheKey !== null &&
            existing.image.cacheKey === owner.cacheKey &&
            runtimeMatches &&
            existing.image.preparationKey !== owner.preparationKey &&
            existing.image.baseCommit &&
            owner.baseCommit &&
            existing.image.baseCommit !== owner.baseCommit
          ) {
            return undefined;
          }
          if (
            state === "missing" &&
            !existing.image.pinned &&
            !held(existing, existing.image.checkpointId)
          ) {
            await deleteImage(context, key, existing);
            existing = (await openStore().lookup(key))!;
            if (existing.image || existing.operation) {
              return undefined;
            }
          } else if (
            state !== "missing" &&
            (existing.image.pinned ||
              Date.now() - existing.image.createdAtMs < dependencies.policy.refreshAfterMs) &&
            runtimeMatches &&
            existing.image.preparationKey === owner.preparationKey &&
            existing.image.cacheKey === owner.cacheKey &&
            !context.projectCaptureRequired &&
            (!owner.projectKey || existing.image.baseCommit === owner.baseCommit)
          ) {
            return undefined;
          }
        }
        const now = Date.now();
        assertCurrent(context);
        // A rejected comparison reply can still leave this fresh selector committed.
        // Record attempted custody before awaiting; exact cleanup never adopts another selector.
        pendingCapture = true;
        const claimed = await openStore().update(
          key,
          (current) => {
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
          },
          authority,
        );
        if (!claimed) {
          pendingCapture = false;
          return undefined;
        }
        // Runtime preparation belongs only to a claimed capture. Scrub its forwarded
        // credential artifacts afterward, before any native image can include them.
        assertCurrent(context);
        if (prepareAndScrubSource) {
          preparing = true;
          await prepareAndScrubSource(SCRUB_WORKER_STATE);
          preparing = false;
        } else {
          await checkpointCommand(
            context,
            "scrub",
            leaseRunArgs(context),
            WARM_IMAGE_COMMAND_ROUND_TRIP_TIMEOUT_MS,
            { input: SCRUB_WORKER_STATE },
          );
        }
        // A stopped allocation or manual recovery must not start another paid operation.
        assertCurrent(context);
        const creating = await openStore().update(
          key,
          (current) =>
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
          authority,
        );
        if (!creating) {
          await clearCrabboxWarmImageCapture(openStore(), key, captureId);
          pendingCapture = false;
          return undefined;
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
              // Daytona and direct Azure snapshots require explicit permission to stop the
              // scrubbed source for capture. Both owners restore or retire it afterward.
              ...(["azure", "daytona"].includes(context.provider) ? ["--no-reboot=false"] : []),
              ...(context.provider === "machine0" ? ["--strategy", "image"] : []),
            ],
            resolveCrabboxCheckpointCaptureTimeoutMs(context.provider),
            {
              onDispatch: () => {
                createDispatched = true;
              },
            },
          ),
          context.id,
        );
        createdCheckpointId = created.checkpointId;
        // Physical completion owns custody, not reusable eligibility. Fence publication
        // at the final store admission; reconcile refused results independently below.
        const published = await openStore().update(
          key,
          (current) => {
            if (current?.operation?.type !== "capture" || current.operation.id !== captureId) {
              return undefined;
            }
            const next = withoutCrabboxWarmImageOperation(current);
            delete next.captureUnsupported;
            // Pin mutations cannot race capture. Retain at most one previous image;
            // the displaced unpinned generation becomes durable deletion debt.
            const predecessor = current.image;
            let retiredCheckpointId: string | undefined;
            if (predecessor && predecessor.checkpointId !== created.checkpointId) {
              if (current.previous?.pinned) {
                retiredCheckpointId = predecessor.checkpointId;
              } else if (predecessor.pinned || dependencies.policy.keepPrevious === 1) {
                next.previous = predecessor;
                retiredCheckpointId = current.previous?.checkpointId;
              } else {
                retiredCheckpointId = predecessor.checkpointId;
              }
            }
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
              ...(retiredCheckpointId
                ? {
                    operation: {
                      type: "retire" as const,
                      checkpointId: retiredCheckpointId,
                    },
                  }
                : {}),
            };
          },
          authority,
        );
        if (!published) {
          warnOnce(
            "capture ownership changed",
            `Checkpoint ${created.checkpointId} returned after recovery of ${captureId}; reconcile it in the Crabbox catalog before resuming captures.`,
          );
          return undefined;
        }
        pendingCapture = false;
        const replacement = await openStore().lookup(key);
        if (replacement) {
          await retireImage(context, key, replacement);
        }
      } catch (error) {
        const unsupported = createDispatched
          ? CrabboxCheckpointCreateError.unsupportedCapture(error, context)
          : undefined;
        const notSubmitted =
          createDispatched && CrabboxCheckpointCreateError.wasNotSubmitted(error, context);
        const captureFailure = {
          error,
          failedProjectAttempt: pendingCapture && Boolean(owner?.projectKey),
        };
        if (pendingCapture && key) {
          try {
            if (unsupported) {
              const recorded = await openStore().update(key, (current) =>
                current?.operation?.type === "capture" && current.operation.id === captureId
                  ? {
                      ...withoutCrabboxWarmImageOperation(current),
                      captureUnsupported: {
                        atMs: Date.now(),
                        provider: context.provider,
                        message: unsupported.message,
                      },
                    }
                  : undefined,
              );
              if (recorded) {
                warnUnsupported(unsupported.message);
                return undefined;
              }
            }
            if (createDispatched && !notSubmitted) {
              await openStore().update(key, (current) =>
                current?.operation?.type === "capture" && current.operation.id === captureId
                  ? {
                      ...current,
                      operation: createdCheckpointId
                        ? { type: "retire", checkpointId: createdCheckpointId }
                        : { ...current.operation, phase: "uncertain" },
                    }
                  : undefined,
              );
              pendingCapture = !createdCheckpointId;
            } else {
              await clearCrabboxWarmImageCapture(openStore(), key, captureId);
              pendingCapture = false;
            }
          } catch {
            // Keep persisted ownership recoverable; physical lease cleanup still belongs to stop.
          }
        }
        // Required project captures must fail before enrollment. Optional teardown
        // captures can warn and let source deletion complete.
        if (preparing) {
          throw error;
        }
        if (notSubmitted && owner?.projectKey) {
          return captureFailure;
        }
        let warning = coerceErrorMessage(error);
        if (createdCheckpointId) {
          warning += `. Checkpoint ${createdCheckpointId} returned for capture ${captureId}.`;
        }
        if (pendingCapture) {
          warning += `. ${crabboxWarmImageRecoveryHint(captureId)}`;
        }
        warnOnce("capture", warning);
        return captureFailure;
      }
      return undefined;
    };
    const captureFailure = await attemptCapture();
    const operation =
      key && owner?.projectKey ? (await openStore().lookup(key))?.operation : undefined;
    // Record capture custody before revalidating; cancellation takes precedence over
    // an unresolved-capture error without discarding its recovery record.
    assertCurrent(context);
    // Exact cleanup or a successor selector cannot turn a failed project attempt into a skip.
    // Keep recovery guidance while this attempt still owns a persisted capture claim.
    if (
      captureFailure?.failedProjectAttempt &&
      (operation?.type !== "capture" || operation.id !== captureId)
    ) {
      throw captureFailure.error;
    }
    // A native create may still be running after a lost response. Enrollment must
    // never introduce node credentials into that source until capture has settled.
    if (operation?.type === "capture" && operation.leaseId === context.id) {
      throw new Error(
        `${captureFailure ? `${coerceErrorMessage(captureFailure.error)}. ` : ""}Crabbox project image capture is unresolved. ${crabboxWarmImageRecoveryHint(operation.id)}`,
      );
    }
    return Boolean(createdCheckpointId);
  };
}
