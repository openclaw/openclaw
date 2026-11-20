import { isDeepStrictEqual } from "node:util";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parseCrabboxJson } from "./crabbox-worker-command.js";
import { inspectWithContext } from "./crabbox-worker-provision-commands.js";
import { WARM_IMAGE_COMMAND_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";
import {
  checkpointCommand,
  CHECKPOINT_ID_PATTERN,
  deleteCheckpoint,
  type MaintenanceContext,
  type CheckpointContext,
} from "./crabbox-worker-warm-image-checkpoint.js";
import {
  crabboxWarmImageHoldingLeaseIds,
  isCrabboxWarmImageHeld,
  withoutCrabboxWarmImageOperation,
  type WarmProfileRecord,
} from "./crabbox-worker-warm-image-records.js";
import {
  clearCrabboxWarmImageCapture,
  sameCrabboxWarmImageGeneration as sameImage,
  type openCrabboxWarmImageStore,
} from "./crabbox-worker-warm-image-store.js";

type RetirementContext = CheckpointContext | MaintenanceContext;

export function createCrabboxWarmImageRetirement(dependencies: {
  openStore: () => ReturnType<typeof openCrabboxWarmImageStore>;
  isLeaseActive: (leaseId: string) => boolean;
  warn: (message: string) => void;
  warnOnce: (action: string, error: unknown, failed?: boolean) => void;
  deleteEmptyProfile: (key: string) => Promise<boolean>;
}) {
  const { openStore, warnOnce, deleteEmptyProfile } = dependencies;
  const assertCurrent = (context: RetirementContext) => {
    context.assertCurrent?.();
    context.signal?.throwIfAborted();
  };
  const releaseRetirementHolds = async (
    context: MaintenanceContext,
    key: string,
    record: WarmProfileRecord,
    remainingMs: () => number,
  ) => {
    if (record.operation?.type !== "retire") {
      return record;
    }
    const checkpointId = record.operation.checkpointId;
    for (const leaseId of crabboxWarmImageHoldingLeaseIds(record, checkpointId)) {
      if (dependencies.isLeaseActive(leaseId) || remainingMs() <= 0) {
        continue;
      }
      const allocation = record.allocations[leaseId];
      try {
        // Older rows without a backend retain their hold for owner-led cleanup.
        await confirmCrabboxWarmImageLeaseGone(
          context,
          { leaseId, provider: record.backend },
          remainingMs,
        );
        await openStore().update(key, (current) => {
          assertCurrent(context);
          if (
            !current ||
            dependencies.isLeaseActive(leaseId) ||
            !isDeepStrictEqual(current.allocations[leaseId], allocation)
          ) {
            return undefined;
          }
          const allocations = { ...current.allocations };
          delete allocations[leaseId];
          return { ...current, allocations };
        });
      } catch (error) {
        assertCurrent(context);
        warnOnce(
          `allocation ${leaseId.slice(0, 128)} reconciliation`,
          coerceErrorMessage(error).slice(0, 1024),
        );
      }
    }
    return openStore().lookup(key);
  };

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
    if (operation?.type !== "retire") {
      return;
    }
    const holders = crabboxWarmImageHoldingLeaseIds(record, operation.checkpointId);
    if (holders.length > 0) {
      warnOnce(
        `checkpoint ${operation.checkpointId} retirement held`,
        `allocation leases: ${holders.join(", ").slice(0, 1024)}`,
        false,
      );
      return;
    }
    if (pinned(record)) {
      return;
    }
    const matches = (current: WarmProfileRecord | undefined) =>
      current?.operation?.type === "retire" &&
      current.operation.checkpointId === operation.checkpointId &&
      sameImage(current.image, record.image) &&
      sameImage(current.previous, record.previous) &&
      !pinned(current) &&
      !isCrabboxWarmImageHeld(current, operation.checkpointId);
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
        // Command errors already bound provider output; report every failed retry.
        dependencies.warn(
          `Crabbox warm image checkpoint retirement (${operation.checkpointId} deletion obligation retained; retry during periodic maintenance or next warm-image-enabled worker teardown; inspect with openclaw crabbox warm-images) failed: ${coerceErrorMessage(error)}`,
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

  return { releaseRetirementHolds, retireImage };
}

/** Confirm source inactivity across every configured catalog; lost custody is not absence. */
async function confirmCrabboxWarmImageLeaseGone(
  context: MaintenanceContext,
  source: { leaseId?: string; provider?: string },
  remainingMs: () => number,
): Promise<void> {
  if (!source.leaseId || !source.provider || context.binaries.length === 0) {
    throw new Error("source lease, provider, or executable is unavailable");
  }
  for (const binary of context.binaries) {
    context.assertCurrent?.();
    context.signal?.throwIfAborted();
    const timeoutMs = remainingMs();
    if (timeoutMs <= 0) {
      throw new Error("reconciliation deadline exceeded");
    }
    const lease = await inspectWithContext({
      ...context,
      binary,
      id: source.leaseId,
      provider: source.provider,
      requireConfirmedAbsence: true,
      timeoutMs,
    });
    // Unlike NON_RUNNABLE_STATES cleanup handling, this only confirms no new capture can start.
    if (
      lease &&
      ![
        "stopped",
        "stopped_with_code",
        "terminated",
        "destroyed",
        "missing",
        "released",
        "expired",
      ].includes(lease.state)
    ) {
      throw new Error(
        `source lease ${source.leaseId} is still alive or unconfirmed (${lease.state})`,
      );
    }
  }
}

export async function reconcileCrabboxWarmImageCapture(
  context: MaintenanceContext,
  store: ReturnType<typeof openCrabboxWarmImageStore>,
  key: string,
  capture: Extract<NonNullable<WarmProfileRecord["operation"]>, { type: "capture" }>,
  remainingMs: () => number,
  info: (message: string) => void,
  isLeaseActive: (leaseId: string) => boolean,
): Promise<string | undefined> {
  const ids = new Set<string>();
  const assertCurrent = () => {
    context.assertCurrent?.();
    context.signal?.throwIfAborted();
    if (capture.leaseId && isLeaseActive(capture.leaseId)) {
      throw new Error(`source lease ${capture.leaseId} has an active dispatch`);
    }
  };
  const timeout = () => {
    assertCurrent();
    const ms = remainingMs();
    if (ms <= 0) {
      throw new Error("reconciliation deadline exceeded");
    }
    return ms;
  };
  try {
    await confirmCrabboxWarmImageLeaseGone(context, capture, timeout);
    for (const binary of context.binaries) {
      const records = parseCrabboxJson(
        await checkpointCommand(
          { ...context, binary },
          "list",
          ["checkpoint", "list", "--json"],
          timeout(),
        ),
        "checkpoint list",
      );
      // Crabbox emits null when the catalog directory does not exist yet.
      if (records === null) {
        continue;
      }
      if (!Array.isArray(records)) {
        throw new Error("checkpoint list returned an invalid catalog");
      }
      for (const record of records) {
        if (
          !isRecord(record) ||
          typeof record.id !== "string" ||
          !CHECKPOINT_ID_PATTERN.test(record.id) ||
          typeof record.leaseId !== "string" ||
          !record.leaseId
        ) {
          throw new Error("checkpoint list returned an invalid checkpoint identity");
        }
        if (record.leaseId === capture.leaseId) {
          ids.add(record.id);
          if (record.provider !== capture.provider) {
            throw new Error(`checkpoint ${record.id} has an unexpected provider`);
          }
        }
      }
    }
    if (ids.size > 1) {
      throw new Error("multiple checkpoints match the source lease");
    }
    const record = await store.lookup(key);
    const current = record?.operation;
    assertCurrent();
    if (current?.type !== "capture" || current.id !== capture.id || current.phase !== "uncertain") {
      throw new Error("capture ownership changed");
    }
    const [checkpointId] = ids;
    if (
      checkpointId &&
      record &&
      (record.image?.checkpointId === checkpointId ||
        record.previous?.checkpointId === checkpointId ||
        isCrabboxWarmImageHeld(record, checkpointId))
    ) {
      throw new Error(
        `checkpoint ${checkpointId} is already owned by a published image or allocation`,
      );
    }
    if (checkpointId && !(await deleteCheckpoint(context, checkpointId, remainingMs))) {
      throw new Error("checkpoint deletion did not complete");
    }
    if (
      await clearCrabboxWarmImageCapture(store, key, capture.id, {
        assertCurrent,
        releaseSourceAllocation: true,
      })
    ) {
      info(
        `Crabbox warm image capture ${capture.id} reconciled: ${checkpointId ? `deleted unvalidated checkpoint ${checkpointId}` : "no checkpoint found"}`,
      );
    }
    return undefined;
  } catch (error) {
    assertCurrent();
    const checkpointIds = [...new Set([...(capture.checkpointIds ?? []), ...ids])].toSorted();
    if (checkpointIds.length > 0) {
      await store.update(key, (record) => {
        assertCurrent();
        return record?.operation?.type === "capture" &&
          record.operation.id === capture.id &&
          JSON.stringify(record.operation.checkpointIds) !== JSON.stringify(checkpointIds)
          ? { ...record, operation: { ...record.operation, checkpointIds } }
          : undefined;
      });
    }
    return `${coerceErrorMessage(error)}${checkpointIds.length ? `; candidate checkpoints: ${checkpointIds.join(", ")}` : ""}`;
  }
}
