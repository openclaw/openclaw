import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parseCrabboxJson } from "./crabbox-worker-command.js";
import { inspectWithContext } from "./crabbox-worker-provision-commands.js";
import {
  checkpointCommand,
  CHECKPOINT_ID_PATTERN,
  deleteCheckpoint,
  type MaintenanceContext,
} from "./crabbox-worker-warm-image-checkpoint.js";
import {
  clearCrabboxWarmImageCapture,
  isCrabboxWarmImageHeld,
  type openCrabboxWarmImageStore,
  type WarmProfileRecord,
} from "./crabbox-worker-warm-image-store.js";

export async function reconcileCrabboxWarmImageCapture(
  context: MaintenanceContext,
  store: ReturnType<typeof openCrabboxWarmImageStore>,
  key: string,
  capture: Extract<NonNullable<WarmProfileRecord["operation"]>, { type: "capture" }>,
  remainingMs: () => number,
  info: (message: string) => void,
): Promise<string | undefined> {
  const ids = new Set<string>();
  const assertCurrent = () => {
    context.assertCurrent?.();
    context.signal?.throwIfAborted();
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
    if (!capture.leaseId || !capture.provider || context.binaries.length === 0) {
      throw new Error("source lease, provider, or executable is unavailable");
    }
    for (const binary of context.binaries) {
      const lease = await inspectWithContext({
        ...context,
        binary,
        id: capture.leaseId,
        provider: capture.provider,
        requireConfirmedAbsence: true,
        timeoutMs: timeout(),
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
          `source lease ${capture.leaseId} is still alive or unconfirmed (${lease.state})`,
        );
      }
    }
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
    if (await clearCrabboxWarmImageCapture(store, key, capture.id, assertCurrent)) {
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
