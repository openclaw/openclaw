// Zalo plugin module owns durable ingress enqueue + drain for inbound updates.
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressDrain,
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import type { ZaloUpdate } from "./api.js";
import { getZaloRuntime } from "./runtime.js";

const ZALO_INGRESS_PAYLOAD_VERSION = 1;
// Tombstones dominate the retired 5-minute in-memory webhook replay guard.
const ZALO_INGRESS_COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ZALO_INGRESS_COMPLETED_MAX_ENTRIES = 20_000;
const ZALO_INGRESS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ZALO_INGRESS_FAILED_MAX_ENTRIES = 1_000;
// Short backoff against transient SQLite contention before failing closed.
const ZALO_INGRESS_ENQUEUE_RETRY_DELAYS_MS = [250, 750] as const;

type ZaloIngressPayload = {
  version: typeof ZALO_INGRESS_PAYLOAD_VERSION;
  receivedAt: number;
  update: ZaloUpdate;
};

/** Turn adoption lifecycle the drain binds into the channel turn (adoption tombstones the claim). */
export type ZaloIngressTurnLifecycle = ReturnType<
  typeof bindIngressLifecycleToReplyOptions
>["turnAdoptionLifecycle"];

export type ZaloIngressEnqueueResult =
  | { kind: "accepted" }
  | { kind: "duplicate" }
  | { kind: "ignored" };

class ZaloIngressPermanentError extends Error {}

function parseZaloIngressPayload(payload: ZaloIngressPayload): ZaloUpdate {
  if (payload.version !== ZALO_INGRESS_PAYLOAD_VERSION || !payload.update.message) {
    throw new ZaloIngressPermanentError("Zalo ingress payload is invalid.");
  }
  return payload.update;
}

/** Stable dedupe id + serialized lane for one delivered update; null when it cannot be journaled. */
function resolveZaloUpdateIngressFacts(update: ZaloUpdate): {
  eventId: string;
  laneKey: string;
} | null {
  const message = update.message;
  const messageId = message?.message_id?.trim();
  if (!message || !messageId) {
    return null;
  }
  // JSON encoding keeps ids unambiguous when chat/sender values contain separators.
  return {
    eventId: JSON.stringify([message.chat.id, message.from.id, messageId]),
    laneKey: `chat:${message.chat.id}`,
  };
}

export function createZaloIngressSpool(params: {
  accountId: string;
  abortSignal: AbortSignal;
  queue?: ChannelIngressQueue<ZaloIngressPayload>;
  retryPolicy?: {
    maxAttempts?: number;
    deadLetterMinAgeMs?: number;
    baseMs?: number;
    maxMs?: number;
  };
  onLog?: (message: string) => void;
  dispatch: (update: ZaloUpdate, lifecycle: ZaloIngressTurnLifecycle) => Promise<void>;
}) {
  const queue =
    params.queue ??
    getZaloRuntime().state.openChannelIngressQueue<ZaloIngressPayload>({
      accountId: params.accountId,
    });
  const drain = createChannelIngressDrain<ZaloIngressPayload>({
    queue,
    abortSignal: params.abortSignal,
    retryPolicy: {
      maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
      deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
      ...params.retryPolicy,
    },
    resolveNonRetryableFailure: (error) =>
      error instanceof ZaloIngressPermanentError
        ? { reason: "invalid-payload", message: error.message }
        : null,
    ...(params.onLog ? { onLog: params.onLog } : {}),
    dispatchClaimedEvent: async (record, lifecycle) => {
      const update = parseZaloIngressPayload(record.payload);
      await params.dispatch(
        update,
        bindIngressLifecycleToReplyOptions(lifecycle).turnAdoptionLifecycle,
      );
    },
  });

  return {
    /** Journal one update durably before dispatch; the Bot API consumes updates on response. */
    enqueue: async (update: ZaloUpdate): Promise<ZaloIngressEnqueueResult> => {
      const facts = resolveZaloUpdateIngressFacts(update);
      if (!facts) {
        // Updates without a message are no-ops downstream; a message without the
        // contract-required message_id can be neither deduped nor replayed.
        if (update.message) {
          params.onLog?.("zalo ingress: dropping update with message but no message_id");
        }
        return { kind: "ignored" };
      }
      const receivedAt = Date.now();
      await queue.prune({
        completedTtlMs: ZALO_INGRESS_COMPLETED_TTL_MS,
        completedMaxEntries: ZALO_INGRESS_COMPLETED_MAX_ENTRIES,
        failedTtlMs: ZALO_INGRESS_FAILED_TTL_MS,
        failedMaxEntries: ZALO_INGRESS_FAILED_MAX_ENTRIES,
      });
      let lastError: unknown;
      for (let attempt = 0; ; attempt += 1) {
        try {
          const result = await queue.enqueue(
            facts.eventId,
            { version: ZALO_INGRESS_PAYLOAD_VERSION, receivedAt, update },
            { receivedAt, laneKey: facts.laneKey },
          );
          return result.kind === "accepted" ? { kind: "accepted" } : { kind: "duplicate" };
        } catch (error) {
          lastError = error;
          const delay = ZALO_INGRESS_ENQUEUE_RETRY_DELAYS_MS[attempt];
          if (delay === undefined || params.abortSignal.aborted) {
            break;
          }
          await sleepWithAbort(delay, params.abortSignal).catch(() => undefined);
        }
      }
      // Fail closed: dispatching an unjournaled update would bypass dedupe and die with the process.
      throw lastError;
    },
    drainOnce: async () => {
      await drain.drainOnce();
    },
    waitForIdle: drain.waitForIdle,
    dispose: () => drain.dispose(),
  };
}

export type ZaloIngressSpool = ReturnType<typeof createZaloIngressSpool>;
