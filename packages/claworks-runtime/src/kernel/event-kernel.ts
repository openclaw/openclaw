import { randomUUID } from "node:crypto";
import type { CwDatabase } from "../planes/data/db-types.js";
import type { PlaybookEngine } from "../planes/orch/playbook-engine.js";
import { HitlSuspendedError } from "../planes/orch/step-executor.js";
import type {
  CapabilityContext,
  CapabilityRegistry,
  CapabilityView,
} from "./capability-registry.js";
import { createDedupGuard, type DedupGuard } from "./dedup.js";
import { createEventBus, type EventBus } from "./event-bus.js";
import { createEventOutbox, type EventOutbox } from "./outbox.js";
import { createPlaybookMatcher, type PlaybookMatcher } from "./playbook-matcher.js";
import { resolvePublishTraceparent, parseTraceparent } from "./trace-context.js";
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
      traceparent?: string;
      idempotencyKey?: string;
      subjectId?: string;
      subjectType?: CwEvent["subjectType"];
    },
  ): Promise<CwEventMatch[]>;
  flushOutbox(): Promise<number>;
  /** 列出所有已注册的能力（委托给 capabilities 注册表）。 */
  listCapabilities(): CapabilityView[];
  /** 订阅事件总线上的特定事件类型，返回取消订阅函数。 */
  subscribe(type: string, handler: (payload: Record<string, unknown>) => void): () => void;
  /** 通过能力注册表调用能力（委托给 capabilities.invoke）。 */
  callCapability(
    id: string,
    ctx: CapabilityContext,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /** 注入能力注册表（在 runtime 组装完成后调用）。 */
  setCapabilityRegistry(registry: CapabilityRegistry): void;
  /** 返回最近 N 条事件（用于 observe.* 能力统计）。 */
  getRecentEvents(limit?: number, type?: string): Array<{ type: string; source: string; ts: Date }>;
}

export type EventKernelOptions = {
  playbookEngine: PlaybookEngine;
  db?: CwDatabase;
  onEventPublished?: (event: CwEvent, matches: CwEventMatch[]) => void;
  logger?: (msg: string) => void;
  dedupWindowMs?: number;
  playbookConcurrency?: number;
  /** 单个用户同时可触发的最大 Playbook 并行数，默认 3。 */
  maxPlaysPerUser?: number;
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
  const maxPlaysPerUser = opts.maxPlaysPerUser ?? 3;
  const runningCounts = new Map<string, number>();
  /** 每个用户当前正在运行的 Playbook 数量（用户级并发保护）。 */
  const userActivePlays = new Map<string, number>();
  const failureState = new Map<string, FailureState>();
  const insertEvent = opts.db?.prepare(`
    INSERT OR REPLACE INTO cw_events (id, type, source, payload, correlation_id, timestamp, subject_id, subject_type, idempotency_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let running = false;
  let capabilityRegistry: CapabilityRegistry | null = null;
  const recentEventLog: Array<{ type: string; source: string; ts: Date }> = [];
  const MAX_RECENT_LOG = 500;

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

    // 用户级并发限制
    const userId = String(event.payload.user_id ?? event.payload.userId ?? "");
    if (userId) {
      const userActive = userActivePlays.get(userId) ?? 0;
      if (userActive >= maxPlaysPerUser) {
        await publishAnomaly({
          kind: "user_concurrency_exceeded",
          playbookId,
          eventType: event.type,
          userId,
          active: userActive,
          limit: maxPlaysPerUser,
        });
        return;
      }
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
    if (userId) {
      userActivePlays.set(userId, (userActivePlays.get(userId) ?? 0) + 1);
    }
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
      if (userId) {
        const userNext = Math.max(0, (userActivePlays.get(userId) ?? 1) - 1);
        if (userNext === 0) {
          userActivePlays.delete(userId);
        } else {
          userActivePlays.set(userId, userNext);
        }
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

      const incomingTraceparent =
        pubOpts?.traceparent ??
        (typeof payload.traceparent === "string" ? payload.traceparent : undefined) ??
        (typeof payload.trace_parent === "string" ? payload.trace_parent : undefined);
      const traceparent = resolvePublishTraceparent(incomingTraceparent);
      const traceCtx = parseTraceparent(traceparent);
      const event: CwEvent = {
        id: randomUUID(),
        type,
        source,
        timestamp: new Date(),
        payload,
        traceparent,
        traceId: traceCtx?.traceId,
        correlationId: pubOpts?.correlationId ?? traceCtx?.traceId,
        subjectId: pubOpts?.subjectId,
        subjectType: pubOpts?.subjectType ?? "system",
        idempotencyKey: pubOpts?.idempotencyKey,
      };
      recentEventLog.push({ type, source, ts: event.timestamp });
      if (recentEventLog.length > MAX_RECENT_LOG) {
        recentEventLog.splice(0, recentEventLog.length - MAX_RECENT_LOG);
      }
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
    listCapabilities(): CapabilityView[] {
      return capabilityRegistry?.list() ?? [];
    },
    subscribe(type: string, handler: (payload: Record<string, unknown>) => void): () => void {
      return bus.subscribe(type, async (event) => {
        handler({
          ...event.payload,
          _event_type: event.type,
          _event_source: event.source,
          _event_id: event.id,
          _event: event,
        });
      });
    },
    async callCapability(
      id: string,
      ctx: CapabilityContext,
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      if (!capabilityRegistry) {
        throw new Error(`CapabilityRegistry not set; cannot call capability: ${id}`);
      }
      return capabilityRegistry.invoke(id, ctx, params);
    },
    setCapabilityRegistry(registry: CapabilityRegistry): void {
      capabilityRegistry = registry;
    },
    getRecentEvents(
      limit = 200,
      filterType?: string,
    ): Array<{ type: string; source: string; ts: Date }> {
      let events = recentEventLog;
      if (filterType) {
        events = events.filter((e) => e.type === filterType);
      }
      return events.slice(-limit);
    },
  };
}
