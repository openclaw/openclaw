// Line plugin module owns durable webhook admission and replay.
import { createHash, randomUUID } from "node:crypto";
import type { webhook } from "@line/bot-sdk";
import type {
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
  ChannelIngressQueueRecord,
} from "openclaw/plugin-sdk/channel-outbound";
import { danger, sleepWithAbort, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import { getLineRuntime } from "./runtime.js";

const LINE_WEBHOOK_SPOOL_VERSION = 1;
const LINE_WEBHOOK_MAX_ATTEMPTS = 8;
const LINE_WEBHOOK_RETRY_BASE_MS = 1_000;
const LINE_WEBHOOK_RETRY_MAX_MS = 3 * 60_000;
const LINE_WEBHOOK_CLAIM_STALE_MS = 30_000;
const LINE_WEBHOOK_CLAIM_REFRESH_MS = 10_000;
const LINE_WEBHOOK_MAX_CONCURRENT_DELIVERIES = 8;
const LINE_WEBHOOK_DRAIN_SCAN_LIMIT = 100;
const LINE_WEBHOOK_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60_000;

type LineWebhookDeadLetterReason =
  | "delivery-side-effects-committed"
  | "invalid-event"
  | "retry-limit-exceeded";

type LineWebhookDeliveryOutcome =
  | { kind: "completed"; eventId: string }
  | { kind: "retry-scheduled"; eventId: string; attempt: number; error: string }
  | {
      kind: "dead-lettered";
      eventId: string;
      attempt: number;
      reason: LineWebhookDeadLetterReason;
      error: string;
    };

type LineWebhookSpoolPayload = {
  version: number;
  destination: string;
  event: webhook.Event;
};

type LineWebhookSpoolOptions = {
  accountId: string;
  runtime: RuntimeEnv;
  deliver: (
    event: webhook.Event,
    destination: string,
    control: { abortSignal: AbortSignal; onTurnAdopted: () => Promise<void> },
  ) => Promise<void>;
  queue?: ChannelIngressQueue<LineWebhookSpoolPayload>;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  claimStaleMs?: number;
  claimRefreshMs?: number;
  onOutcome?: (outcome: LineWebhookDeliveryOutcome) => void;
};

class LineWebhookClaimOwnershipError extends Error {
  constructor(eventId: string) {
    super(`LINE webhook spool event ${eventId} lost claim ownership.`);
    this.name = "LineWebhookClaimOwnershipError";
  }
}

class LineWebhookClaimRefreshError extends Error {
  constructor(eventId: string, options?: { cause?: unknown }) {
    super(`LINE webhook spool event ${eventId} claim refresh failed.`, options);
    this.name = "LineWebhookClaimRefreshError";
  }
}

export class LineWebhookTerminalDeliveryError extends Error {
  readonly reason = "delivery-side-effects-committed" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LineWebhookTerminalDeliveryError";
  }
}

type LineWebhookSpool = {
  accept: (body: webhook.CallbackRequest) => Promise<void>;
  start: () => void;
  stop: () => Promise<void>;
};

function eventIdFor(event: webhook.Event): string {
  const eventId = (event as { webhookEventId?: unknown }).webhookEventId;
  if (typeof eventId === "string" && eventId.trim()) {
    return eventId.trim();
  }
  return `invalid:${createHash("sha256").update(JSON.stringify(event)).digest("hex")}`;
}

function laneKeyFor(event: webhook.Event): string {
  const source = (event as { source?: webhook.Event["source"] }).source;
  if (source?.type === "group") {
    return `group:${source.groupId}`;
  }
  if (source?.type === "room") {
    return `room:${source.roomId}`;
  }
  if (source?.type === "user") {
    return `user:${source.userId}`;
  }
  return `event:${eventIdFor(event)}`;
}

function isValidPayload(payload: LineWebhookSpoolPayload): boolean {
  return (
    payload.version === LINE_WEBHOOK_SPOOL_VERSION &&
    typeof payload.destination === "string" &&
    typeof payload.event === "object" &&
    payload.event !== null &&
    typeof (payload.event as { webhookEventId?: unknown }).webhookEventId === "string" &&
    Boolean((payload.event as { webhookEventId: string }).webhookEventId.trim())
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryDelayMs(
  record: ChannelIngressQueueRecord<LineWebhookSpoolPayload>,
  now: number,
  baseMs: number,
  maxMs: number,
): number {
  if (record.attempts < 1 || record.lastAttemptAt === undefined) {
    return 0;
  }
  const delay = Math.min(maxMs, baseMs * 2 ** Math.min(record.attempts - 1, 8));
  return Math.max(0, record.lastAttemptAt + delay - now);
}

export function createLineWebhookSpool(options: LineWebhookSpoolOptions): LineWebhookSpool {
  const queue =
    options.queue ??
    getLineRuntime().state.openChannelIngressQueue<LineWebhookSpoolPayload>({
      accountId: options.accountId,
    });
  const ownerId = `${process.pid}:${randomUUID()}`;
  const maxAttempts = Math.max(1, options.maxAttempts ?? LINE_WEBHOOK_MAX_ATTEMPTS);
  const retryBaseMs = Math.max(0, options.retryBaseMs ?? LINE_WEBHOOK_RETRY_BASE_MS);
  const retryMaxMs = Math.max(retryBaseMs, options.retryMaxMs ?? LINE_WEBHOOK_RETRY_MAX_MS);
  const claimStaleMs = Math.max(0, options.claimStaleMs ?? LINE_WEBHOOK_CLAIM_STALE_MS);
  const claimRefreshMs = Math.max(1, options.claimRefreshMs ?? LINE_WEBHOOK_CLAIM_REFRESH_MS);
  let running = false;
  let draining = false;
  let drainRequested = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let drainDeadline: number | undefined;
  const drainTasks = new Set<Promise<void>>();
  const activeDeliveries = new Map<string, Promise<void>>();
  const activeClaims = new Map<
    string,
    { abortController: AbortController; stopRefresh: () => void }
  >();
  const backoffBlockedLanes = new Map<string, number>();

  const prune = async (): Promise<void> => {
    await queue.prune({
      completedTtlMs: LINE_WEBHOOK_TOMBSTONE_TTL_MS,
      failedTtlMs: LINE_WEBHOOK_TOMBSTONE_TTL_MS,
    });
  };

  const scheduleDrain = (delayMs: number): void => {
    if (!running) {
      return;
    }
    const deadline = Date.now() + Math.max(0, delayMs);
    if (drainTimer && drainDeadline !== undefined && drainDeadline <= deadline) {
      return;
    }
    if (drainTimer) {
      clearTimeout(drainTimer);
    }
    drainDeadline = deadline;
    drainTimer = setTimeout(
      () => {
        drainTimer = undefined;
        drainDeadline = undefined;
        // Timers preserve the HTTP request's admission context. Give every drain
        // its own tracked root so durable work can continue after the request ACK.
        const task = runDetachedWebhookWork(drain).catch((error: unknown) => {
          options.runtime.error?.(
            danger(`line: webhook spool admission failed: ${errorText(error)}`),
          );
          scheduleDrain(retryBaseMs || 1_000);
        });
        drainTasks.add(task);
        void task.finally(() => drainTasks.delete(task));
      },
      Math.max(0, deadline - Date.now()),
    );
    drainTimer.unref?.();
  };

  const persistClaimTransition = async (params: {
    claim: ChannelIngressQueueClaim<LineWebhookSpoolPayload>;
    label: string;
    transition: () => Promise<boolean>;
    abortSignal?: AbortSignal;
  }): Promise<void> => {
    let persistenceAttempt = 0;
    while (true) {
      try {
        if (!(await params.transition())) {
          throw new LineWebhookClaimOwnershipError(params.claim.id);
        }
        return;
      } catch (error) {
        if (error instanceof LineWebhookClaimOwnershipError) {
          throw error;
        }
        persistenceAttempt += 1;
        const delayMs = Math.min(5_000, 250 * 2 ** Math.min(persistenceAttempt - 1, 5));
        options.runtime.error?.(
          danger(
            `line: webhook event ${params.claim.id} ${params.label} persist failed; retrying: ${errorText(error)}`,
          ),
        );
        await sleepWithAbort(delayMs, params.abortSignal);
      }
    }
  };

  const finishClaim = async (
    claim: ChannelIngressQueueClaim<LineWebhookSpoolPayload>,
  ): Promise<LineWebhookDeliveryOutcome> => {
    const attempt = claim.attempts + 1;
    const abortController = new AbortController();
    let adopted = false;
    let refreshing = true;
    const claimRefreshTimer = setInterval(() => {
      if (!refreshing) {
        return;
      }
      void (async () => {
        try {
          const refreshed = await queue.refreshClaim?.(claim);
          if (refreshed !== true && !adopted && refreshing) {
            throw new LineWebhookClaimOwnershipError(claim.id);
          }
        } catch (error) {
          if (adopted || !refreshing) {
            return;
          }
          options.runtime.error?.(
            danger(`line: webhook spool claim refresh failed: ${errorText(error)}`),
          );
          stopRefresh();
          abortController.abort(new LineWebhookClaimRefreshError(claim.id, { cause: error }));
        }
      })();
    }, claimRefreshMs);
    claimRefreshTimer.unref?.();
    const stopRefresh = () => {
      if (!refreshing) {
        return;
      }
      refreshing = false;
      clearInterval(claimRefreshTimer);
    };
    activeClaims.set(claim.id, { abortController, stopRefresh });
    try {
      if (!isValidPayload(claim.payload)) {
        const error = "LINE webhook spool payload was invalid.";
        await persistClaimTransition({
          claim,
          label: "invalid dead-letter",
          transition: async () =>
            await queue.fail(claim, { reason: "invalid-event", message: error }),
        });
        return {
          kind: "dead-lettered",
          eventId: claim.id,
          attempt,
          reason: "invalid-event",
          error,
        };
      }
      try {
        await options.deliver(claim.payload.event, claim.payload.destination, {
          abortSignal: abortController.signal,
          onTurnAdopted: async () => {
            await persistClaimTransition({
              claim,
              label: "adoption completion",
              transition: async () => await queue.complete(claim),
            });
            adopted = true;
            stopRefresh();
          },
        });
      } catch (error) {
        if (adopted) {
          return { kind: "completed", eventId: claim.id };
        }
        const message = errorText(error);
        if (error instanceof LineWebhookTerminalDeliveryError) {
          await persistClaimTransition({
            claim,
            label: "terminal dead-letter",
            transition: async () => await queue.fail(claim, { reason: error.reason, message }),
          });
          return {
            kind: "dead-lettered",
            eventId: claim.id,
            attempt,
            reason: error.reason,
            error: message,
          };
        }
        if (abortController.signal.aborted) {
          const refreshFailed =
            abortController.signal.reason instanceof LineWebhookClaimRefreshError;
          await persistClaimTransition({
            claim,
            label: refreshFailed ? "refresh-failure release" : "shutdown release",
            transition: async () =>
              await queue.release(
                claim,
                refreshFailed
                  ? { lastError: errorText(abortController.signal.reason) }
                  : { recordAttempt: false },
              ),
          });
          throw error;
        }
        if (attempt >= maxAttempts) {
          await persistClaimTransition({
            claim,
            label: "retry-limit dead-letter",
            transition: async () =>
              await queue.fail(claim, { reason: "retry-limit-exceeded", message }),
          });
          return {
            kind: "dead-lettered",
            eventId: claim.id,
            attempt,
            reason: "retry-limit-exceeded",
            error: message,
          };
        }
        await persistClaimTransition({
          claim,
          label: "retry release",
          transition: async () => await queue.release(claim, { lastError: message }),
        });
        return { kind: "retry-scheduled", eventId: claim.id, attempt, error: message };
      }

      if (adopted) {
        return { kind: "completed", eventId: claim.id };
      }

      await persistClaimTransition({
        claim,
        label: "completion",
        transition: async () => await queue.complete(claim),
      });
      return { kind: "completed", eventId: claim.id };
    } finally {
      activeClaims.delete(claim.id);
      stopRefresh();
    }
  };

  const drain = async (): Promise<void> => {
    if (!running) {
      return;
    }
    if (draining) {
      drainRequested = true;
      return;
    }
    draining = true;
    drainRequested = false;
    try {
      // The short lease recovers a crashed predecessor before LINE's reply-token
      // use window, while refreshes protect a still-live rolling-restart owner.
      await queue.recoverStaleClaims({ staleMs: claimStaleMs });
      const claims = await queue.listClaims();
      const now = Date.now();
      let nextDelay = Number.POSITIVE_INFINITY;
      for (const claim of claims) {
        nextDelay = Math.min(nextDelay, Math.max(0, claim.claim.claimedAt + claimStaleMs - now));
      }
      const blockedLaneKeys = new Set(activeDeliveries.keys());
      for (const [laneKey, deadline] of backoffBlockedLanes) {
        if (deadline <= now) {
          backoffBlockedLanes.delete(laneKey);
        } else {
          blockedLaneKeys.add(laneKey);
          nextDelay = Math.min(nextDelay, deadline - now);
        }
      }
      for (const claim of claims) {
        if (claim.laneKey) {
          blockedLaneKeys.add(claim.laneKey);
        }
      }
      let scanned = 0;
      while (
        activeDeliveries.size < LINE_WEBHOOK_MAX_CONCURRENT_DELIVERIES &&
        scanned < LINE_WEBHOOK_DRAIN_SCAN_LIMIT
      ) {
        if (!running) {
          break;
        }
        const claim = await queue.claimNext({
          ownerId,
          blockedLaneKeys,
          orderBy: "id",
          scanLimit: LINE_WEBHOOK_DRAIN_SCAN_LIMIT,
        });
        if (!claim) {
          break;
        }
        scanned += 1;
        if (!running) {
          await persistClaimTransition({
            claim,
            label: "shutdown claim release",
            transition: async () => await queue.release(claim, { recordAttempt: false }),
          });
          break;
        }
        const laneKey = claim.laneKey ?? `event:${claim.id}`;
        blockedLaneKeys.add(laneKey);
        const delay = retryDelayMs(claim, now, retryBaseMs, retryMaxMs);
        if (delay > 0) {
          backoffBlockedLanes.set(laneKey, now + delay);
          nextDelay = Math.min(nextDelay, delay);
          await persistClaimTransition({
            claim,
            label: "backoff release",
            transition: async () => await queue.release(claim, { recordAttempt: false }),
          });
          continue;
        }
        // The scan root may finish immediately after launching work. Reserve a
        // separate admitted continuation for the full delivery lifecycle.
        const delivery = runDetachedWebhookWork(() => finishClaim(claim))
          .then((outcome) => {
            options.onOutcome?.(outcome);
            if (outcome.kind === "retry-scheduled") {
              options.runtime.error?.(
                danger(
                  `line: webhook event ${outcome.eventId} delivery failed on attempt ${outcome.attempt}: ${outcome.error}`,
                ),
              );
            } else if (outcome.kind === "dead-lettered") {
              options.runtime.error?.(
                danger(
                  `line: webhook event ${outcome.eventId} dead-lettered (${outcome.reason}): ${outcome.error}`,
                ),
              );
            }
          })
          .catch((error: unknown) => {
            options.runtime.error?.(
              danger(`line: webhook event ${claim.id} worker failed: ${errorText(error)}`),
            );
          })
          .finally(() => {
            if (activeDeliveries.get(laneKey) === delivery) {
              activeDeliveries.delete(laneKey);
            }
            scheduleDrain(0);
          });
        activeDeliveries.set(laneKey, delivery);
      }
      if (scanned >= LINE_WEBHOOK_DRAIN_SCAN_LIMIT) {
        scheduleDrain(0);
      }
      if (Number.isFinite(nextDelay)) {
        scheduleDrain(nextDelay);
      }
    } catch (error) {
      options.runtime.error?.(danger(`line: webhook spool drain failed: ${errorText(error)}`));
      scheduleDrain(retryBaseMs || 1_000);
    } finally {
      draining = false;
      if (drainRequested) {
        scheduleDrain(0);
      }
    }
  };

  return {
    accept: async (body) => {
      const events = body.events ?? [];
      if (events.length === 0) {
        return;
      }
      await prune();
      const receivedAt = Date.now();
      for (const event of events) {
        await queue.enqueue(
          eventIdFor(event),
          {
            version: LINE_WEBHOOK_SPOOL_VERSION,
            destination: body.destination ?? "",
            event,
          },
          { receivedAt, laneKey: laneKeyFor(event) },
        );
        scheduleDrain(0);
      }
    },
    start: () => {
      if (running) {
        return;
      }
      running = true;
      scheduleDrain(0);
    },
    stop: async () => {
      running = false;
      if (drainTimer) {
        clearTimeout(drainTimer);
        drainTimer = undefined;
        drainDeadline = undefined;
      }
      for (const active of activeClaims.values()) {
        active.stopRefresh();
        active.abortController.abort();
      }
      await Promise.allSettled([...drainTasks, ...activeDeliveries.values()]);
    },
  };
}
