import { isDeepStrictEqual } from "node:util";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import {
  buildCrabboxAllocationArgs,
  resolveCrabboxWarmImageProfileKey,
  type parseCrabboxProfile,
  type resolveCrabboxProvisionProfile,
} from "./crabbox-worker-profile.js";
import { runProvisionWarmup } from "./crabbox-worker-provision-commands.js";
import { WARM_IMAGE_COMMAND_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";
import { createCrabboxWarmImageCapture } from "./crabbox-worker-warm-image-capture.js";
import {
  createCheckpointCommands,
  parseCheckpointAvailability,
  parseForkedCheckpoint,
  type CheckpointContext,
  type MaintenanceContext,
} from "./crabbox-worker-warm-image-checkpoint.js";
import {
  resolveCrabboxWarmImagePolicy,
  type CrabboxWarmImagePolicy,
} from "./crabbox-worker-warm-image-policy.js";
import { WARM_IMAGE_MAX_ENTRIES } from "./crabbox-worker-warm-image-records.js";
import {
  assertCrabboxWarmImageMigrationReady,
  crabboxWarmImageCaptureStatus,
  crabboxWarmImageRecoveryHint,
  CRABBOX_WARM_IMAGE_WAIT_HINT,
  CrabboxWarmImageRequestError,
  isCrabboxWarmImageCaptureUncertain,
  isCrabboxWarmImageHeld as held,
  openCrabboxWarmImageStore,
  projectCrabboxWarmImage,
  sameCrabboxWarmImageGeneration as sameImage,
  withCrabboxWarmImageDisplayFacts,
  withCrabboxWarmImageGeneration,
  withoutCrabboxWarmImageOperation,
  type CrabboxState,
  type WarmImageRecord,
  type WarmProfileRecord,
  type WarmAllocationRecord,
} from "./crabbox-worker-warm-image-store.js";

type CrabboxProfile = ReturnType<typeof parseCrabboxProfile>;
type RetirementContext = CheckpointContext | MaintenanceContext;
type LeaseContext = CheckpointContext & {
  id: string;
  provider: string;
};
type AllocationContext = LeaseContext & {
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

export function createCrabboxWarmImageManager(dependencies: {
  state: CrabboxState;
  runCommand: CrabboxCommandRunner;
  runArgs: (context: LeaseContext) => string[];
  warn: (message: string) => void;
  policy?: CrabboxWarmImagePolicy;
}) {
  const policy = dependencies.policy ?? resolveCrabboxWarmImagePolicy();
  let store: ReturnType<typeof openCrabboxWarmImageStore> | undefined;
  const warned = new Set<string>();
  let pausedCaptureSnapshot = "";
  const openStore = () => (store ??= openCrabboxWarmImageStore(dependencies.state));
  const assertCurrent = (context: RetirementContext) => {
    context.assertCurrent?.();
    context.signal?.throwIfAborted();
  };
  const warnOnce = (action: string, error: unknown, failed = true) => {
    const message = `Crabbox warm image ${action}${failed ? " failed" : ""}: ${coerceErrorMessage(error)}`;
    if (!warned.has(message)) {
      // Periodic failures can carry changing request IDs; never retain an unbounded log cache.
      if (warned.size >= WARM_IMAGE_MAX_ENTRIES) {
        warned.clear();
      }
      warned.add(message);
      dependencies.warn(message);
    }
  };
  const { checkpointCommand, deleteCheckpoint } = createCheckpointCommands(dependencies.runCommand);
  const imageExpired = (image: WarmImageRecord) =>
    !image.pinned &&
    (image.lastDemandAtMs === null || Date.now() - image.lastDemandAtMs >= policy.retainUnusedMs);
  const retiringCurrent = (record: WarmProfileRecord) =>
    record.operation?.type === "retire" &&
    record.operation.checkpointId === record.image?.checkpointId;
  const deleteEmptyProfile = (key: string) =>
    openStore().deleteIf(
      key,
      (record) =>
        !record.image &&
        !record.previous &&
        !record.operation &&
        Object.keys(record.allocations).length === 0,
    );

  const lookupLease = (id: string) => openStore().lookupLease(id);

  const retireImage = async (
    context: RetirementContext,
    key: string,
    record: WarmProfileRecord,
    remainingMs: () => number = () => WARM_IMAGE_COMMAND_TIMEOUT_MS,
  ): Promise<void> => {
    const operation = record.operation;
    const pinned = (current: WarmProfileRecord) =>
      [current.image, current.previous].some(
        (image) =>
          operation?.type === "retire" &&
          image?.checkpointId === operation.checkpointId &&
          image.pinned,
      );
    if (operation?.type !== "retire" || held(record, operation.checkpointId) || pinned(record)) {
      return;
    }
    const matches = (current: WarmProfileRecord | undefined) =>
      current?.operation?.type === "retire" &&
      current.operation.checkpointId === operation.checkpointId &&
      sameImage(current.image, record.image) &&
      sameImage(current.previous, record.previous) &&
      !pinned(current) &&
      !held(current, operation.checkpointId);
    if (!matches(await openStore().lookup(key))) {
      return;
    }
    try {
      if (!(await deleteCheckpoint(context, operation.checkpointId, remainingMs))) {
        return;
      }
    } catch (error) {
      assertCurrent(context);
      if (matches(await openStore().lookup(key))) {
        warnOnce(
          `checkpoint retirement (${operation.checkpointId} deletion obligation retained; retry during periodic maintenance or next warm-image-enabled worker teardown; inspect with openclaw crabbox warm-images)`,
          error,
        );
      }
      return;
    }
    await openStore().update(key, (current) => {
      assertCurrent(context);
      if (!current || !matches(current)) {
        return undefined;
      }
      const next = withoutCrabboxWarmImageOperation(current);
      if (next.image?.checkpointId === operation.checkpointId) {
        delete next.image;
      }
      if (next.previous?.checkpointId === operation.checkpointId) {
        delete next.previous;
      }
      return next;
    });
    await deleteEmptyProfile(key);
  };

  const deleteImage = async (
    context: RetirementContext,
    key: string,
    record: WarmProfileRecord,
    remainingMs: () => number = () => WARM_IMAGE_COMMAND_TIMEOUT_MS,
    checkpointId = record.image?.checkpointId,
  ) => {
    const image = [record.image, record.previous].find(
      (candidate) => candidate?.checkpointId === checkpointId,
    );
    if (!image || !checkpointId || image.pinned || record.operation || held(record, checkpointId)) {
      return;
    }
    assertCurrent(context);
    const retiring: WarmProfileRecord = {
      ...record,
      operation: { type: "retire", checkpointId },
    };
    // Choice admission and retirement claim the same row; neither can pass an older observation.
    if (
      await openStore().update(key, (current) => {
        assertCurrent(context);
        return JSON.stringify(current) === JSON.stringify(record) ? retiring : undefined;
      })
    ) {
      await retireImage(context, key, retiring, remainingMs);
    }
  };

  const collectImages = async (context: RetirementContext, phase: "allocation" | "teardown") => {
    const deadline = Date.now() + WARM_IMAGE_COMMAND_TIMEOUT_MS;
    const entries = await openStore().entries();
    assertCurrent(context);
    const paused = entries
      .flatMap(({ key, value }) => {
        const capture = crabboxWarmImageCaptureStatus(key, value);
        return capture && isCrabboxWarmImageCaptureUncertain(capture) ? [capture.selector] : [];
      })
      .toSorted();
    const snapshot = JSON.stringify(paused);
    if (snapshot !== pausedCaptureSnapshot) {
      pausedCaptureSnapshot = snapshot;
      if (paused.length > 0) {
        dependencies.warn(
          `Crabbox warm image capture paused (${paused.length}; ${paused.join(", ")}): ${crabboxWarmImageRecoveryHint(paused.length === 1 ? paused[0]! : "<selector>")}`,
        );
      }
    }
    for (const { key, value } of entries) {
      assertCurrent(context);
      const capture = crabboxWarmImageCaptureStatus(key, value);
      if (capture) {
        if (!isCrabboxWarmImageCaptureUncertain(capture) && capture.stale) {
          warnOnce(
            `capture ${capture.selector} still pending`,
            CRABBOX_WARM_IMAGE_WAIT_HINT,
            false,
          );
        }
        continue;
      }
      if (value.operation && phase === "allocation") {
        continue;
      }
      const remaining = () => deadline - Date.now();
      if (remaining() <= 0) {
        break;
      }
      await retireImage(context, key, value, remaining);
      let current = await openStore().lookup(key);
      if (
        current?.previous &&
        !current.operation &&
        !current.previous.pinned &&
        (policy.keepPrevious === 0 || imageExpired(current.previous)) &&
        remaining() > 0
      ) {
        await deleteImage(context, key, current, remaining, current.previous.checkpointId);
        current = await openStore().lookup(key);
      }
      if (
        current?.image &&
        sameImage(current.image, value.image) &&
        !current.operation &&
        imageExpired(current.image) &&
        remaining() > 0
      ) {
        await deleteImage(context, key, current, remaining);
      }
    }
  };

  const makeRoom = async (context: LeaseContext) => {
    const deadline = Date.now() + WARM_IMAGE_COMMAND_TIMEOUT_MS;
    const entries = await openStore().entries();
    if (entries.length < WARM_IMAGE_MAX_ENTRIES) {
      return;
    }
    const candidates = entries
      .filter(({ value }) => !value.operation && Object.keys(value.allocations).length === 0)
      .toSorted(
        (a, b) => (a.value.image?.lastDemandAtMs ?? 0) - (b.value.image?.lastDemandAtMs ?? 0),
      );
    // Previous generations are reclaimed first, but a slot is freed only when its
    // whole profile has no images, allocations, or deletion obligations left.
    for (const generation of ["previous", "image"] as const) {
      for (const { key } of candidates) {
        if ((await openStore().count()) < WARM_IMAGE_MAX_ENTRIES) {
          return;
        }
        const remaining = () => deadline - Date.now();
        if (remaining() <= 0) {
          break;
        }
        const current = await openStore().lookup(key);
        const image = current?.[generation];
        if (current && image && (generation === "previous" || !current.previous)) {
          await deleteImage(context, key, current, remaining, image.checkpointId);
        } else if (generation === "image") {
          await deleteEmptyProfile(key);
        }
      }
    }
    if ((await openStore().count()) >= WARM_IMAGE_MAX_ENTRIES) {
      throw new Error(
        "Crabbox warm-image profile capacity is full; stop outstanding workers or resolve cleanup with openclaw crabbox warm-images before retrying.",
      );
    }
  };

  const verifyImage = async (context: LeaseContext, checkpointId: string) => {
    const args = ["checkpoint", "inspect", checkpointId, "--verify", "--json"];
    return parseCheckpointAvailability(await checkpointCommand(context, "inspect", args));
  };

  const selectAllocation = async (
    context: AllocationContext,
    profile: CrabboxProfile & { class: string },
  ) => {
    if (!context.nodeRuntimeIdentity) {
      throw new Error("Crabbox warm-image allocation requires a prepared node runtime identity");
    }
    const preparationKey = context.preparation?.key ?? null;
    const cacheKey = context.preparation?.cacheKey ?? null;
    const purpose = context.preparation?.purpose ?? null;
    if (
      context.preparation &&
      (!context.projectKey ||
        profile.target !== "linux" ||
        !/^[a-f0-9]{64}$/u.test(context.preparation.key) ||
        !/^[a-f0-9]{64}$/u.test(context.preparation.cacheKey) ||
        (purpose !== "session" && purpose !== "reserve") ||
        !Number.isSafeInteger(context.preparation.demandAtMs) ||
        context.preparation.demandAtMs < 0)
    ) {
      throw new Error("Crabbox project preparation identity is invalid.");
    }
    const key = resolveCrabboxWarmImageProfileKey(profile, context.projectKey);
    const displayFacts = {
      profileId: context.profileId,
      backend: profile.provider,
      machineClass: profile.class,
      os: profile.target,
      projectLabel: context.projectLabel,
      projectRoot: context.projectRoot,
    };
    const replay = await lookupLease(context.id);
    if (replay) {
      if (
        replay.key !== key ||
        replay.machineClass !== profile.class ||
        (replay.os ?? "linux") !== profile.target ||
        replay.preparationKey !== preparationKey ||
        replay.cacheKey !== cacheKey ||
        replay.purpose !== purpose ||
        (context.preparation && replay.demandAtMs !== context.preparation.demandAtMs)
      ) {
        throw new Error(
          "Crabbox provision retry changed its recorded profile or project identity.",
        );
      }
      if (!isDeepStrictEqual(replay.runtimeIdentity, context.nodeRuntimeIdentity)) {
        throw new Error(
          "Crabbox provision retry changed or lacks its recorded node runtime identity; stop the worker before reprovisioning",
        );
      }
      assertCurrent(context);
      const updated = await openStore().update(key, (record) => {
        assertCurrent(context);
        const allocation = record?.allocations[context.id];
        return record &&
          allocation &&
          isDeepStrictEqual({ key, projectKey: record.projectKey, ...allocation }, replay)
          ? withCrabboxWarmImageDisplayFacts(record, displayFacts)
          : undefined;
      });
      if (!updated) {
        throw new Error(
          "Crabbox allocation changed before provisioning completed; retry the worker operation.",
        );
      }
      return replay;
    }
    await collectImages(context, "allocation");
    const observed = await openStore().lookup(key);
    let available = Boolean(
      observed?.image &&
      observed.image.lastDemandAtMs !== null &&
      (cacheKey !== null
        ? observed.image.cacheKey === cacheKey
        : observed.image.preparationKey === null && observed.image.cacheKey === null) &&
      !retiringCurrent(observed),
    );
    if (available && observed?.image?.state === "pending") {
      try {
        const state = await verifyImage(context, observed.image.checkpointId);
        available = state === "available";
        if (state === "missing") {
          await deleteImage(context, key, observed);
        }
      } catch (error) {
        assertCurrent(context);
        available = false;
        warnOnce("verification", error);
      }
    }
    if (!(await openStore().lookup(key))) {
      await makeRoom(context);
    }
    assertCurrent(context);
    // Crabbox binds even a cold (empty checkpoint) intent to the fixed lease.
    // Freeze the choice before the first CLI call so a lost response cannot select a newer image.
    return openStore().recordAllocation({
      key,
      id: context.id,
      projectKey: context.projectKey,
      displayFacts,
      assertCurrent: () => assertCurrent(context),
      availableImage: available ? observed?.image : undefined,
      allocation: {
        machineClass: profile.class,
        os: profile.target,
        phase: "pending",
        runtimeIdentity: structuredClone(context.nodeRuntimeIdentity),
        preparationKey,
        cacheKey,
        purpose,
        demandAtMs: context.preparation?.demandAtMs ?? Date.now(),
      },
    });
  };

  const checkpointEntry = async (checkpointId: string) => {
    const entry = (await openStore().entries()).find(
      ({ value }) =>
        value.image?.checkpointId === checkpointId ||
        value.previous?.checkpointId === checkpointId ||
        (value.operation?.type === "retire" && value.operation.checkpointId === checkpointId),
    );
    if (!entry) {
      throw new CrabboxWarmImageRequestError("Unknown snapshot checkpoint.");
    }
    return entry;
  };
  const updateCheckpoint = async (
    checkpointId: string,
    change: (record: WarmProfileRecord) => WarmProfileRecord | string,
    assertOwnerCurrent?: () => void,
  ) => {
    const { key } = await checkpointEntry(checkpointId);
    let rejection: string | undefined;
    let accepted: WarmProfileRecord | undefined;
    const updated = await openStore().update(key, (record) => {
      assertOwnerCurrent?.();
      rejection = undefined;
      accepted = undefined;
      if (!record) {
        rejection = "Snapshot changed; refresh the list and retry.";
        return undefined;
      }
      const next = change(record);
      if (typeof next === "string") {
        rejection = next;
        return undefined;
      }
      accepted = next;
      return next;
    });
    if (!updated || !accepted || rejection) {
      throw new CrabboxWarmImageRequestError(rejection ?? "Snapshot changed; refresh and retry.");
    }
    return projectCrabboxWarmImage(key, accepted);
  };

  return {
    pin(checkpointId: string, pinned: boolean, assertOwnerCurrent?: () => void) {
      return updateCheckpoint(
        checkpointId,
        (record) => {
          if (record.operation) {
            return "Wait for the profile's capture or retirement to finish before changing a pin.";
          }
          const field = record.image?.checkpointId === checkpointId ? "image" : "previous";
          const image = record[field];
          if (image?.checkpointId !== checkpointId) {
            return "Unknown snapshot checkpoint.";
          }
          const updated = { ...image };
          if (pinned) {
            updated.pinned ??= { atMs: Date.now() };
          } else {
            delete updated.pinned;
          }
          return { ...record, [field]: updated };
        },
        assertOwnerCurrent,
      );
    },
    rollback(checkpointId: string, assertOwnerCurrent?: () => void) {
      return updateCheckpoint(
        checkpointId,
        (record) => {
          if (record.operation) {
            return "Wait for the profile's capture or retirement to finish before rolling back.";
          }
          if (record.previous?.checkpointId !== checkpointId) {
            return "Rollback requires a previous snapshot checkpoint.";
          }
          const next: WarmProfileRecord = { ...record, image: record.previous };
          delete next.previous;
          if (record.image) {
            if (policy.keepPrevious === 1 || record.image.pinned) {
              next.previous = record.image;
            } else {
              next.operation = { type: "retire", checkpointId: record.image.checkpointId };
            }
          }
          return next;
        },
        assertOwnerCurrent,
      );
    },
    async delete(
      context: MaintenanceContext,
      checkpointId: string,
    ): Promise<{ status: "deleted" | "retiring" }> {
      assertCurrent(context);
      const { key, value } = await checkpointEntry(checkpointId);
      if (value.operation?.type === "capture") {
        throw new CrabboxWarmImageRequestError(
          "A snapshot cannot be deleted while its profile is capturing.",
        );
      }
      if (held(value, checkpointId)) {
        throw new CrabboxWarmImageRequestError(
          "Stop outstanding allocations before deleting this snapshot.",
        );
      }
      if (
        [value.image, value.previous].some(
          (image) => image?.checkpointId === checkpointId && image.pinned,
        )
      ) {
        throw new CrabboxWarmImageRequestError("Unpin this snapshot before deleting it.");
      }
      if (value.operation) {
        if (value.operation.checkpointId !== checkpointId) {
          throw new CrabboxWarmImageRequestError(
            "Wait for the profile's current retirement to finish.",
          );
        }
        await retireImage(context, key, value);
      } else {
        await deleteImage(context, key, value, undefined, checkpointId);
      }
      assertCurrent(context);
      const current = await openStore().lookup(key);
      if (
        current?.operation?.type === "retire" &&
        current.operation.checkpointId === checkpointId
      ) {
        return { status: "retiring" };
      }
      if (
        current?.image?.checkpointId === checkpointId ||
        current?.previous?.checkpointId === checkpointId
      ) {
        throw new CrabboxWarmImageRequestError(
          "Snapshot changed; refresh the list and retry deletion.",
        );
      }
      return { status: "deleted" };
    },
    maintain: async (context: MaintenanceContext) => {
      assertCurrent(context);
      await assertCrabboxWarmImageMigrationReady(dependencies.state);
      await collectImages(
        { ...context, binaries: [...new Set(context.binaries)].toSorted() },
        "teardown",
      );
    },
    lookupLease,
    markPrepared: (id: string, baseCommit: string, assertOwnerCurrent?: () => void) =>
      openStore().markPrepared(id, baseCommit, assertOwnerCurrent),
    markEnrolled: (id: string, assertOwnerCurrent?: () => void) =>
      openStore().markEnrolled(id, assertOwnerCurrent),

    notePreparedDemand: (id: string, preparation: { preparationKey: string; demandAtMs: number }) =>
      openStore().notePreparedDemand(id, preparation),

    async release(context: LeaseContext) {
      // Only confirmed stop releases this hold: enrollment success may itself be a lost response,
      // and replay still needs the original checkpoint catalog entry and native artifact.
      const owner = await lookupLease(context.id);
      if (!owner) {
        return;
      }
      await openStore().update(owner.key, (record) => {
        if (!record?.allocations[context.id]) {
          return undefined;
        }
        const allocations = { ...record.allocations };
        delete allocations[context.id];
        return { ...record, allocations };
      });
      const deadline = Date.now() + WARM_IMAGE_COMMAND_TIMEOUT_MS;
      const remaining = () => deadline - Date.now();
      const current = await openStore().lookup(owner.key);
      if (current) {
        await retireImage(context, owner.key, current, remaining);
      }
      const released = await openStore().lookup(owner.key);
      if (released?.image?.lastDemandAtMs === null) {
        // A failed session never earned retention. Keep any failed deletion as normal debt.
        await deleteImage(context, owner.key, released, remaining);
      }
      await deleteEmptyProfile(owner.key);
    },

    capture: createCrabboxWarmImageCapture({
      policy,
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
      runArgs: dependencies.runArgs,
    }),

    async allocate(context: AllocationContext): Promise<WarmAllocationRecord["choice"]> {
      assertCurrent(context);
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
        await assertCrabboxWarmImageMigrationReady(dependencies.state);
        const owner = await selectAllocation(context, context.profile);
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
      assertCurrent(context);
      await runProvisionWarmup({
        ...context,
        runCommand: dependencies.runCommand,
      });
      return { kind: "cold" };
    },
  };
}
