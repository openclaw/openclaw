// Telegram plugin module implements bot update tracker behavior.
import {
  createMessageReceiveContext,
  type MessageAckPolicy,
  type MessageReceiveContext,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  buildTelegramUpdateKey,
  createTelegramUpdateDedupe,
  resolveTelegramUpdateId,
  type TelegramUpdateKeyContext,
} from "./bot-updates.js";

type PersistUpdateId = (updateId: number) => void | Promise<void>;

type TelegramUpdateTrackerOptions = {
  initialUpdateId?: number | null;
  persistenceFloorUpdateId?: number | null;
  ackPolicy?: MessageAckPolicy;
  onAcceptedUpdateId?: PersistUpdateId;
  onPersistError?: (error: unknown) => void;
  onSkip?: (key: string) => void;
};

type AcceptedTelegramUpdate = {
  key?: string;
  updateId?: number;
  receiveContext?: MessageReceiveContext<TelegramUpdateKeyContext>;
};

type BeginUpdateResult =
  | {
      accepted: true;
      update: AcceptedTelegramUpdate;
    }
  | {
      accepted: false;
      reason: "accepted-watermark" | "semantic-dedupe";
    };

type FinishUpdateOptions = {
  completed: boolean;
};

type TelegramUpdateTrackerState = {
  highestAcceptedUpdateId: number | null;
  highestPersistedAcceptedUpdateId: number | null;
  highestCompletedUpdateId: number | null;
  safeCompletedUpdateId: number | null;
  pendingUpdateIds: number[];
  failedUpdateIds: number[];
};

function sortedIds(ids: Set<number>): number[] {
  return [...ids].toSorted((a, b) => a - b);
}

// Bound for per-id numeric dedupe when the persisted Bot API offset does not
// advance (no onAcceptedUpdateId) or lags. Only the realistic in-process
// redelivery window needs numeric retention; semantic keys + spool tombstones
// cover older ids.
const ACCEPTED_UPDATE_ID_RETENTION = 10_000;

// Transient failures persisting the Bot API offset are retried with a bounded
// exponential backoff. Without a retry, a temporary state-store outage would
// permanently strand the durable offset behind the processed position, so a
// gateway restart would resume from the stale offset and re-deliver updates
// that were already handled.
const PERSIST_RETRY_BASE_DELAY_MS = 250;
const PERSIST_RETRY_MAX_DELAY_MS = 5_000;

export function createTelegramUpdateTracker(options: TelegramUpdateTrackerOptions = {}) {
  const initialUpdateId =
    typeof options.initialUpdateId === "number" ? options.initialUpdateId : null;
  const persistenceFloorUpdateId =
    typeof options.persistenceFloorUpdateId === "number"
      ? options.persistenceFloorUpdateId
      : initialUpdateId;
  const ackPolicy = options.ackPolicy ?? "after_receive_record";
  const recentUpdates = createTelegramUpdateDedupe();
  const pendingUpdateKeys = new Set<string>();
  const activeHandledUpdateKeys = new Map<string, boolean>();
  const pendingUpdateIds = new Set<number>();
  const failedUpdateIds = new Set<number>();
  // Per-id acceptance, not a global high-water mark: multi-lane spool drains can
  // finish newer update IDs before an older delayed id from another chat replays.
  const acceptedUpdateIds = new Set<number>();
  let highestAcceptedUpdateId: number | null = initialUpdateId;
  let highestPersistedAcceptedUpdateId: number | null = persistenceFloorUpdateId;
  let highestPersistenceRequestedUpdateId: number | null = persistenceFloorUpdateId;
  let highestCompletedUpdateId: number | null = persistenceFloorUpdateId;
  let persistInFlight = false;
  let persistTargetUpdateId: number | null = null;
  let persistRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let persistRetryAttempts = 0;
  // Once the owning bot is disposed the tracker must never persist again: account
  // removal and token changes intentionally clear the stored offset, so a late
  // retry writing a retired offset back would recreate a stale-offset path.
  let disposed = false;
  // Handle to the in-flight drain so `dispose()` can fence a persistence write
  // that has already been dispatched to the store before shutdown completes.
  let activeDrain: Promise<void> | undefined;

  const skip = (key: string) => {
    options.onSkip?.(key);
  };

  // One prune rule: drop accepted ids at or below max(persisted offset,
  // highestAccepted - retention) unless still pending or failed. Persisted
  // floor is safe (getUpdates cannot redeliver below it); retention bounds
  // trackers that never advance a persisted floor.
  const pruneAcceptedUpdateIds = () => {
    if (highestAcceptedUpdateId === null && highestPersistedAcceptedUpdateId === null) {
      return;
    }
    const windowFloor =
      highestAcceptedUpdateId === null
        ? Number.NEGATIVE_INFINITY
        : highestAcceptedUpdateId - ACCEPTED_UPDATE_ID_RETENTION;
    const persistedFloor =
      highestPersistedAcceptedUpdateId === null
        ? Number.NEGATIVE_INFINITY
        : highestPersistedAcceptedUpdateId;
    const pruneAtOrBelow = Math.max(persistedFloor, windowFloor);
    for (const id of acceptedUpdateIds) {
      if (id > pruneAtOrBelow) {
        continue;
      }
      if (pendingUpdateIds.has(id) || failedUpdateIds.has(id)) {
        continue;
      }
      acceptedUpdateIds.delete(id);
    }
  };

  const schedulePersistRetry = () => {
    if (disposed || persistRetryTimer !== undefined || persistTargetUpdateId === null) {
      return;
    }
    const delay = Math.min(
      PERSIST_RETRY_MAX_DELAY_MS,
      PERSIST_RETRY_BASE_DELAY_MS * 2 ** persistRetryAttempts,
    );
    persistRetryAttempts += 1;
    persistRetryTimer = setTimeout(() => {
      persistRetryTimer = undefined;
      kickDrain();
    }, delay);
    // Retrying a watermark write must not keep the process alive on its own.
    persistRetryTimer.unref?.();
  };

  const drainPersistQueue = async () => {
    const persist = options.onAcceptedUpdateId;
    if (persistInFlight || disposed || typeof persist !== "function") {
      return;
    }
    persistInFlight = true;
    try {
      while (persistTargetUpdateId !== null) {
        // `disposed` can flip during the awaited write below; stop promptly so a
        // retired offset is never persisted after the owning bot has stopped.
        if (disposed) {
          break;
        }
        const updateId = persistTargetUpdateId;
        persistTargetUpdateId = null;
        try {
          await persist(updateId);
          persistRetryAttempts = 0;
          if (
            highestPersistedAcceptedUpdateId === null ||
            updateId > highestPersistedAcceptedUpdateId
          ) {
            highestPersistedAcceptedUpdateId = updateId;
            pruneAcceptedUpdateIds();
          }
        } catch (err) {
          options.onPersistError?.(err);
          // A dispose that raced with the in-flight write must win: the offset is
          // being retired on purpose, so stop instead of re-arming a retry.
          if (disposed) {
            break;
          }
          // Do not drop the failed offset. Re-arm it (unless a newer coalesced
          // target already superseded it) and roll the coalescing request
          // watermark back to the durable floor so the same offset can be
          // requested and retried. Leaving the request watermark advanced here
          // is what previously stranded the durable offset: the write was never
          // retried, and a later higher offset could persist past the gap.
          if (persistTargetUpdateId === null) {
            persistTargetUpdateId = updateId;
          }
          highestPersistenceRequestedUpdateId = highestPersistedAcceptedUpdateId;
          break;
        }
      }
    } finally {
      persistInFlight = false;
    }
    if (!disposed && persistTargetUpdateId !== null) {
      schedulePersistRetry();
    }
  };

  // Start a drain and retain a handle so disposal can await an already-dispatched
  // write. `activeDrain` is cleared only when the run it started is the current one.
  const kickDrain = () => {
    const run = drainPersistQueue()
      .catch((err: unknown) => {
        options.onPersistError?.(err);
      })
      .finally(() => {
        if (activeDrain === run) {
          activeDrain = undefined;
        }
      });
    activeDrain = run;
  };

  const requestPersistAcceptedUpdateId = (updateId: number) => {
    if (disposed || typeof options.onAcceptedUpdateId !== "function") {
      return;
    }
    if (
      highestPersistenceRequestedUpdateId !== null &&
      updateId <= highestPersistenceRequestedUpdateId
    ) {
      return;
    }
    highestPersistenceRequestedUpdateId = updateId;
    persistTargetUpdateId = updateId;
    kickDrain();
  };

  const acceptUpdateId = (updateId: number) => {
    acceptedUpdateIds.add(updateId);
    if (highestAcceptedUpdateId === null || updateId > highestAcceptedUpdateId) {
      highestAcceptedUpdateId = updateId;
    }
    pruneAcceptedUpdateIds();
  };

  function resolveSafeCompletedUpdateId() {
    if (highestCompletedUpdateId === null) {
      return null;
    }
    let safeCompletedUpdateId = highestCompletedUpdateId;
    for (const updateId of pendingUpdateIds) {
      if (persistenceFloorUpdateId !== null && updateId <= persistenceFloorUpdateId) {
        continue;
      }
      if (updateId <= safeCompletedUpdateId) {
        safeCompletedUpdateId = updateId - 1;
      }
    }
    for (const updateId of failedUpdateIds) {
      if (persistenceFloorUpdateId !== null && updateId <= persistenceFloorUpdateId) {
        continue;
      }
      if (updateId <= safeCompletedUpdateId) {
        safeCompletedUpdateId = updateId - 1;
      }
    }
    return safeCompletedUpdateId;
  }

  const persistUpdateIdAfterAck = async (updateId: number) => {
    const persistUpdateId =
      ackPolicy === "after_agent_dispatch" ? resolveSafeCompletedUpdateId() : updateId;
    if (persistUpdateId !== null) {
      requestPersistAcceptedUpdateId(persistUpdateId);
    }
  };

  const ackUpdateAfterStage = (
    receiveContext: MessageReceiveContext<TelegramUpdateKeyContext> | undefined,
    stage: "receive_record" | "agent_dispatch",
  ) => {
    if (!receiveContext?.shouldAckAfter(stage)) {
      return;
    }
    void receiveContext.ack().catch((err: unknown) => {
      options.onPersistError?.(err);
    });
  };

  const beginUpdate = (ctx: TelegramUpdateKeyContext): BeginUpdateResult => {
    const updateId = resolveTelegramUpdateId(ctx);
    const updateKey = buildTelegramUpdateKey(ctx);
    if (typeof updateId === "number") {
      if (failedUpdateIds.has(updateId)) {
        failedUpdateIds.delete(updateId);
      } else if (initialUpdateId !== null && updateId <= initialUpdateId) {
        // Restored Bot API offset: suppress redelivery of already-persisted ids.
        skip(`update:${updateId}`);
        return { accepted: false, reason: "accepted-watermark" };
      } else if (acceptedUpdateIds.has(updateId)) {
        // Same process already accepted this exact id (completed or in-flight).
        skip(`update:${updateId}`);
        return { accepted: false, reason: "accepted-watermark" };
      }
    }
    if (updateKey) {
      if (pendingUpdateKeys.has(updateKey) || recentUpdates.peek(updateKey)) {
        skip(updateKey);
        return { accepted: false, reason: "semantic-dedupe" };
      }
      pendingUpdateKeys.add(updateKey);
      activeHandledUpdateKeys.set(updateKey, false);
    }
    let receiveContext: MessageReceiveContext<TelegramUpdateKeyContext> | undefined;
    if (typeof updateId === "number") {
      pendingUpdateIds.add(updateId);
      acceptUpdateId(updateId);
      receiveContext = createMessageReceiveContext({
        id: updateKey ?? `telegram:update:${updateId}`,
        channel: "telegram",
        message: ctx,
        ackPolicy,
        onAck: () => persistUpdateIdAfterAck(updateId),
      });
      ackUpdateAfterStage(receiveContext, "receive_record");
    }
    return {
      accepted: true,
      update: {
        ...(updateKey ? { key: updateKey } : {}),
        ...(typeof updateId === "number" ? { updateId } : {}),
        ...(receiveContext ? { receiveContext } : {}),
      },
    };
  };

  const finishUpdate = (update: AcceptedTelegramUpdate, finish: FinishUpdateOptions) => {
    if (update.key) {
      activeHandledUpdateKeys.delete(update.key);
      if (finish.completed) {
        recentUpdates.check(update.key);
      }
      pendingUpdateKeys.delete(update.key);
    }
    if (typeof update.updateId === "number") {
      pendingUpdateIds.delete(update.updateId);
      if (finish.completed) {
        failedUpdateIds.delete(update.updateId);
        if (highestCompletedUpdateId === null || update.updateId > highestCompletedUpdateId) {
          highestCompletedUpdateId = update.updateId;
        }
        ackUpdateAfterStage(update.receiveContext, "agent_dispatch");
      } else {
        failedUpdateIds.add(update.updateId);
        void update.receiveContext
          ?.nack(new Error("Telegram update handler did not complete"))
          .catch((err: unknown) => {
            options.onPersistError?.(err);
          });
      }
      pruneAcceptedUpdateIds();
    }
  };

  const shouldSkipHandlerDispatch = (ctx: TelegramUpdateKeyContext) => {
    const updateId = resolveTelegramUpdateId(ctx);
    if (typeof updateId === "number" && initialUpdateId !== null && updateId <= initialUpdateId) {
      return true;
    }
    const key = buildTelegramUpdateKey(ctx);
    if (!key) {
      return false;
    }
    const handled = activeHandledUpdateKeys.get(key);
    if (handled != null) {
      if (handled) {
        skip(key);
        return true;
      }
      activeHandledUpdateKeys.set(key, true);
      return false;
    }
    const skipped = recentUpdates.check(key);
    if (skipped) {
      skip(key);
    }
    return skipped;
  };

  const getState = (): TelegramUpdateTrackerState => ({
    highestAcceptedUpdateId,
    highestPersistedAcceptedUpdateId,
    highestCompletedUpdateId,
    safeCompletedUpdateId: resolveSafeCompletedUpdateId(),
    pendingUpdateIds: sortedIds(pendingUpdateIds),
    failedUpdateIds: sortedIds(failedUpdateIds),
  });

  // Release the tracker together with its owning bot. Latching `disposed` and
  // clearing the pending retry timer stops any scheduled or future write, and
  // awaiting the in-flight drain fences a write that was already dispatched to
  // the store. Callers (the bot stop hook) await this before offset cleanup so a
  // started write can never resurrect an offset that removal/token change retires.
  const dispose = async () => {
    disposed = true;
    if (persistRetryTimer !== undefined) {
      clearTimeout(persistRetryTimer);
      persistRetryTimer = undefined;
    }
    persistTargetUpdateId = null;
    await activeDrain;
  };

  return {
    beginUpdate,
    finishUpdate,
    getState,
    shouldSkipHandlerDispatch,
    dispose,
  };
}
