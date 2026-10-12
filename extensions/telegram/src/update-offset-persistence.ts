// The durable ingress spool owns delivery; this cursor is monotonic catch-up.
import { asSafeIntegerInRange } from "openclaw/plugin-sdk/string-coerce-runtime";

type TelegramUpdateOffsetPersistenceOptions = {
  initialUpdateId: number | null;
  writeUpdateId: (updateId: number) => Promise<void>;
  onInvalidUpdateId: (updateId: number) => void;
  onError: (failure: { error: unknown; updateId: number }) => void;
  abortSignal?: AbortSignal;
};

export function normalizeTelegramUpdateId(value: number | null): number | null {
  return asSafeIntegerInRange(value, { min: 0 }) ?? null;
}

export function createTelegramUpdateOffsetPersistence(
  options: TelegramUpdateOffsetPersistenceOptions,
) {
  let stopped = false;
  let acceptedUpdateId = options.initialUpdateId;
  let committedUpdateId = options.initialUpdateId;
  let pendingUpdateId: number | null = null;
  let activeDrain: Promise<void> | undefined;

  const drain = async () => {
    while (pendingUpdateId !== null) {
      if (stopped || options.abortSignal?.aborted) {
        return;
      }
      const updateId = pendingUpdateId;
      pendingUpdateId = null;
      try {
        await options.writeUpdateId(updateId);
        committedUpdateId = updateId;
      } catch (error) {
        // A later update retries checkpoint catch-up. Restart replay is spool-deduped.
        options.onError({ error, updateId });
      }
    }
  };

  const startDrain = () => {
    if (activeDrain) {
      return;
    }
    activeDrain = drain()
      .catch(() => undefined)
      .finally(() => {
        activeDrain = undefined;
        if (pendingUpdateId !== null && !stopped && !options.abortSignal?.aborted) {
          startDrain();
        }
      });
  };

  return {
    getCommittedUpdateId: () => committedUpdateId,
    persistUpdateId: (updateId: number) => {
      if (stopped || options.abortSignal?.aborted) {
        return;
      }
      const normalizedUpdateId = normalizeTelegramUpdateId(updateId);
      if (normalizedUpdateId === null) {
        options.onInvalidUpdateId(updateId);
        return;
      }
      if (acceptedUpdateId !== null && normalizedUpdateId <= acceptedUpdateId) {
        return;
      }
      acceptedUpdateId = normalizedUpdateId;
      pendingUpdateId = normalizedUpdateId;
      startDrain();
    },
    async stop() {
      stopped = true;
      await activeDrain?.catch(() => undefined);
    },
  };
}
