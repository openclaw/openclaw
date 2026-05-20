import { randomUUID } from "node:crypto";
import type { CwDatabase } from "../planes/data/db-types.js";
import type { PlaybookEngine } from "../planes/orch/playbook-engine.js";
import { HitlSuspendedError } from "../planes/orch/step-executor.js";
import { createDedupGuard, type DedupGuard } from "./dedup.js";
import { createEventBus, type EventBus } from "./event-bus.js";
import { createEventOutbox, type EventOutbox } from "./outbox.js";
import { createPlaybookMatcher, type PlaybookMatcher } from "./playbook-matcher.js";
import type { CwEvent, CwEventMatch } from "./types.js";

export interface EventKernel {
  bus: EventBus;
  matcher: PlaybookMatcher;
  outbox: EventOutbox | null;
  dedup: DedupGuard;
  start(): Promise<void>;
  stop(): Promise<void>;
  publish(
    type: string,
    source: string,
    payload: Record<string, unknown>,
    opts?: {
      correlationId?: string;
      idempotencyKey?: string;
      subjectId?: string;
      subjectType?: CwEvent["subjectType"];
    },
  ): Promise<CwEventMatch[]>;
  flushOutbox(): Promise<number>;
}

export type EventKernelOptions = {
  playbookEngine: PlaybookEngine;
  db?: CwDatabase;
  onEventPublished?: (event: CwEvent, matches: CwEventMatch[]) => void;
  logger?: (msg: string) => void;
  dedupWindowMs?: number;
  playbookConcurrency?: number;
  publishAnomaly?: (payload: Record<string, unknown>) => Promise<void>;
  onOutboxExhausted?: (payload: Record<string, unknown>) => Promise<void>;
};

type FailureState = {
  failCount: number;
  coolingUntil: number;
};

export function createEventKernel(opts: EventKernelOptions): EventKernel {
  const matcher = createPlaybookMatcher();
  const outbox = opts.db ? createEventOutbox(opts.db) : null;
  const dedup = createDedupGuard(opts.dedupWindowMs ?? 60_000);
  const playbookConcurrency = opts.playbookConcurrency ?? 10;
  const runningCounts = new Map<string, number>();
  const failureState = new Map<string, FailureState>();
  const insertEvent = opts.db?.prepare(`
    INSERT OR REPLACE INTO cw_events (id, type, source, payload, correlation_id, timestamp, subject_id, subject_type, idempotency_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let running = false;

  async function publishAnomaly(payload: Record<string, unknown>): Promise<void> {
    if (!opts.publishAnomaly) {
      return;
    }
    try {
      await opts.publishAnomaly(payload);
    } catch (err) {
      opts.logger?.(
        `[claworks:kernel] publishAnomaly failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function triggerPlaybook(
    playbookId: string,
    input: Record<string, unknown>,
    event: CwEvent,
  ): Promise<void> {
    const cooling = failureState.get(playbookId);
    if (cooling && cooling.coolingUntil > Date.now()) {
      await publishAnomaly({
        kind: "circuit_open",
        playbookId,
        eventType: event.type,
        coolingUntil: cooling.coolingUntil,
      });
      return;
    }

    const concurrent = runningCounts.get(playbookId) ?? 0;
    if (concurrent >= playbookConcurrency) {
      await publishAnomaly({
        kind: "concurrency_exceeded",
        playbookId,
        eventType: event.type,
        concurrent,
        limit: playbookConcurrency,
      });
      return;
    }

    runningCounts.set(playbookId, concurrent + 1);
    try {
      await opts.playbookEngine.trigger(playbookId, input, { triggerEvent: event });
      failureState.set(playbookId, { failCount: 0, coolingUntil: 0 });
    } catch (err) {
      if (err instanceof HitlSuspendedError) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      opts.logger?.(`[claworks:kernel] playbook ${playbookId} failed: ${message}`);
      const state = failureState.get(playbookId) ?? { failCount: 0, coolingUntil: 0 };
      state.failCount += 1;
      if (state.failCount >= 3) {
        state.coolingUntil = Date.now() + 60_000;
        await publishAnomaly({
          kind: "playbook_failure_threshold",
          playbookId,
          eventType: event.type,
          failCount: state.failCount,
          error: message,
        });
      }
      failureState.set(playbookId, state);
      outbox?.enqueue("playbook.trigger", {
        playbookId,
        input,
        error: message,
      });
    } finally {
      const next = Math.max(0, (runningCounts.get(playbookId) ?? 1) - 1);
      if (next === 0) {
        runningCounts.delete(playbookId);
      } else {
        runningCounts.set(playbookId, next);
      }
    }
  }

  async function handleScheduleFired(event: CwEvent): Promise<void> {
    const playbookId = String(event.payload.playbook_id ?? "");
    if (!playbookId) {
      opts.logger?.("[claworks:kernel] system.schedule.fired missing playbook_id");
      return;
    }
    const dedupKey = dedup.buildKey(event.source, event.type, playbookId);
    if (dedup.shouldSkip(dedupKey)) {
      return;
    }
    dedup.record(dedupKey);
    await triggerPlaybook(playbookId, { ...event.payload, _event: event }, event);
  }

  const bus = createEventBus({
    matcher,
    onMatch: async (matches) => {
      for (const match of matches) {
        const dedupKey = dedup.buildKey(match.event.source, match.event.type, match.playbookId);
        if (dedup.shouldSkip(dedupKey)) {
          opts.logger?.(
            `[claworks:kernel] dedup skip playbook=${match.playbookId} event=${match.event.type}`,
          );
          continue;
        }
        dedup.record(dedupKey);
        await triggerPlaybook(match.playbookId, match.input, match.event);
      }
    },
  });

  return {
    bus,
    matcher,
    outbox,
    dedup,
    async start() {
      running = true;
    },
    async stop() {
      running = false;
    },
    async publish(type, source, payload, pubOpts) {
      if (!running) {
        throw new Error("EventKernel not started");
      }

      if (pubOpts?.idempotencyKey) {
        const idemKey = dedup.buildKey(source, type, pubOpts.idempotencyKey);
        if (dedup.shouldSkip(idemKey)) {
          opts.logger?.(`[claworks:kernel] idempotency skip key=${pubOpts.idempotencyKey}`);
          return [];
        }
        dedup.record(idemKey);
      }

      const event: CwEvent = {
        id: randomUUID(),
        type,
        source,
        timestamp: new Date(),
        payload,
        correlationId: pubOpts?.correlationId,
        subjectId: pubOpts?.subjectId,
        subjectType: pubOpts?.subjectType ?? "system",
        idempotencyKey: pubOpts?.idempotencyKey,
      };
      insertEvent?.run(
        event.id,
        event.type,
        event.source,
        JSON.stringify(event.payload),
        event.correlationId ?? null,
        event.timestamp.getTime(),
        event.subjectId ?? null,
        event.subjectType ?? null,
        event.idempotencyKey ?? null,
      );

      if (type === "system.schedule.fired") {
        await handleScheduleFired(event);
        return [];
      }

      const matches = await bus.publish(event);
      opts.onEventPublished?.(event, matches);
      return matches;
    },
    async flushOutbox() {
      if (!outbox) {
        return 0;
      }
      return outbox.flush(
        async (delivery) => {
          if (delivery.kind !== "playbook.trigger") {
            opts.logger?.(`[claworks:kernel] unknown outbox kind: ${delivery.kind}`);
            return;
          }
          const playbookId = String(delivery.payload.playbookId ?? "");
          const input = delivery.payload.input as Record<string, unknown>;
          const synthetic: CwEvent = {
            id: delivery.id,
            type: "system.outbox.retry",
            source: "outbox",
            timestamp: new Date(),
            payload: delivery.payload,
            subjectType: "system",
            subjectId: "outbox",
          };
          await triggerPlaybook(playbookId, input, synthetic);
        },
        {
          onExhausted: async (delivery) => {
            await publishAnomaly({
              kind: "outbox_exhausted",
              outboxId: delivery.id,
              outboxKind: delivery.kind,
              payload: delivery.payload,
              attempts: delivery.attempts,
              lastError: delivery.lastError,
            });
            if (opts.onOutboxExhausted) {
              await opts.onOutboxExhausted({
                outboxId: delivery.id,
                kind: delivery.kind,
                payload: delivery.payload,
              });
            }
          },
        },
      );
    },
  };
}
