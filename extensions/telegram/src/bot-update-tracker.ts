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
      reason: "accepted-watermark" | "semantic-dedupe" | "pending";
    };

type FinishUpdateOptions = {
  completed: boolean;
};

// Bound for per-id numeric dedupe when the persisted Bot API offset does not
// advance (no onAcceptedUpdateId) or lags. Only the realistic in-process
// redelivery window needs numeric retention; semantic keys + spool tombstones
// cover older ids.
const ACCEPTED_UPDATE_ID_RETENTION = 10_000;

export function createTelegramUpdateTracker(options: TelegramUpdateTrackerOptions = {}) {
  const initialUpdateId =
    typeof options.initialUpdateId === "number" ? options.initialUpdateId : null;
  const persistenceFloorUpdateId =
    typeof options.persistenceFloorUpdateId === "number"
      ? options.persistenceFloorUpdateId
      : initialUpdateId;
  const ackPolicy = options.ackPolicy ?? "after_receive_record";
  const recentUpdates = createTelegramUpdateDedupe();
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
  const reportPersistError = (error: unknown) => {
    options.onPersistError?.(error);
  };

  // One prune rule: drop accepted ids at or below max(persisted offset,
  // highestAccepted - retention) unless still pending or failed. Persisted
  // floor is safe (getUpdates cannot redeliver below it); retention bounds
  // trackers that never advance a persisted floor.
  const pruneAcceptedUpdateIds = () => {
    const windowFloor =
      (highestAcceptedUpdateId ?? Number.NEGATIVE_INFINITY) - ACCEPTED_UPDATE_ID_RETENTION;
    const persistedFloor = highestPersistedAcceptedUpdateId ?? Number.NEGATIVE_INFINITY;
    const pruneAtOrBelow = Math.max(persistedFloor, windowFloor);
    for (const id of acceptedUpdateIds) {
      if (id > pruneAtOrBelow || pendingUpdateIds.has(id) || failedUpdateIds.has(id)) {
        continue;
      }
      acceptedUpdateIds.delete(id);
    }
  };

  const drainPersistQueue = async () => {
    const persist = options.onAcceptedUpdateId;
    if (persistInFlight || typeof persist !== "function") {
      return;
    }
    persistInFlight = true;
    try {
      while (persistTargetUpdateId !== null) {
        const updateId = persistTargetUpdateId;
        persistTargetUpdateId = null;
        try {
          await persist(updateId);
          if (
            highestPersistedAcceptedUpdateId === null ||
            updateId > highestPersistedAcceptedUpdateId
          ) {
            highestPersistedAcceptedUpdateId = updateId;
            pruneAcceptedUpdateIds();
          }
        } catch (err) {
          reportPersistError(err);
        }
      }
    } finally {
      persistInFlight = false;
    }
  };

  const requestPersistAcceptedUpdateId = (updateId: number) => {
    if (typeof options.onAcceptedUpdateId !== "function") {
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
    void drainPersistQueue().catch(reportPersistError);
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
    for (const ids of [pendingUpdateIds, failedUpdateIds]) {
      for (const updateId of ids) {
        if (persistenceFloorUpdateId !== null && updateId <= persistenceFloorUpdateId) {
          continue;
        }
        if (updateId <= safeCompletedUpdateId) {
          safeCompletedUpdateId = updateId - 1;
        }
      }
    }
    return safeCompletedUpdateId;
  }

  const ackUpdateAfterStage = (
    receiveContext: MessageReceiveContext<TelegramUpdateKeyContext> | undefined,
    stage: "receive_record" | "agent_dispatch",
  ) => {
    if (!receiveContext?.shouldAckAfter(stage)) {
      return;
    }
    void receiveContext.ack().catch(reportPersistError);
  };

  const beginUpdate = (ctx: TelegramUpdateKeyContext): BeginUpdateResult => {
    const updateId = resolveTelegramUpdateId(ctx);
    const updateKey = buildTelegramUpdateKey(ctx);
    if (typeof updateId === "number") {
      if (failedUpdateIds.has(updateId)) {
        failedUpdateIds.delete(updateId);
      } else if (initialUpdateId !== null && updateId <= initialUpdateId) {
        // Suppress restored offsets for already-persisted ids.
        options.onSkip?.(`update:${updateId}`);
        return { accepted: false, reason: "accepted-watermark" };
      } else if (acceptedUpdateIds.has(updateId)) {
        // Pending middleware is not a terminal processing fact for a spool retry.
        options.onSkip?.(`update:${updateId}`);
        return {
          accepted: false,
          reason: pendingUpdateIds.has(updateId) ? "pending" : "accepted-watermark",
        };
      }
    }
    if (updateKey) {
      if (activeHandledUpdateKeys.has(updateKey)) {
        options.onSkip?.(updateKey);
        return { accepted: false, reason: "pending" };
      }
      if (recentUpdates.peek(updateKey)) {
        options.onSkip?.(updateKey);
        return { accepted: false, reason: "semantic-dedupe" };
      }
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
        onAck: async () => {
          const persistUpdateId =
            ackPolicy === "after_agent_dispatch" ? resolveSafeCompletedUpdateId() : updateId;
          if (persistUpdateId !== null) {
            requestPersistAcceptedUpdateId(persistUpdateId);
          }
        },
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
          .catch(reportPersistError);
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
        options.onSkip?.(key);
        return true;
      }
      activeHandledUpdateKeys.set(key, true);
      return false;
    }
    const skipped = recentUpdates.peek(key);
    if (skipped) {
      options.onSkip?.(key);
    }
    return skipped;
  };

  return {
    beginUpdate,
    finishUpdate,
    shouldSkipHandlerDispatch,
  };
}
