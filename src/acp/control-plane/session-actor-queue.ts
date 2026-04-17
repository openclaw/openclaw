import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("acp/session-actor-queue");

const DEFAULT_BACKLOG_WARN_THRESHOLD = 3;
const BACKLOG_WARN_RATE_LIMIT_MS = 30_000;

function resolveBacklogWarnThreshold(): number {
  const raw = process.env.OPENCLAW_ACP_QUEUE_WARN_THRESHOLD;
  if (typeof raw !== "string" || raw.trim() === "") {
    return DEFAULT_BACKLOG_WARN_THRESHOLD;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_BACKLOG_WARN_THRESHOLD;
  }
  return parsed;
}

export class SessionActorQueue {
  private readonly queue = new KeyedAsyncQueue();
  private readonly pendingBySession = new Map<string, number>();
  // Tracks the last warn emission timestamp per session key so we don't spam
  // logs when a backlog stays over threshold for a while.
  private readonly lastWarnAt = new Map<string, number>();
  // Tracks whether the key is currently flagged as "over threshold" so each
  // threshold-crossing (rising edge) emits at most one warn.
  private readonly overThreshold = new Set<string>();

  getTailMapForTesting(): Map<string, Promise<void>> {
    return this.queue.getTailMapForTesting();
  }

  getTotalPendingCount(): number {
    let total = 0;
    for (const count of this.pendingBySession.values()) {
      total += count;
    }
    return total;
  }

  getPendingCountForSession(actorKey: string): number {
    return this.pendingBySession.get(actorKey) ?? 0;
  }

  private maybeWarnOnBacklog(actorKey: string, pendingCount: number): void {
    const threshold = resolveBacklogWarnThreshold();
    if (pendingCount < threshold) {
      return;
    }
    const now = Date.now();
    const lastAt = this.lastWarnAt.get(actorKey) ?? 0;
    const isRisingEdge = !this.overThreshold.has(actorKey);
    if (!isRisingEdge && now - lastAt < BACKLOG_WARN_RATE_LIMIT_MS) {
      return;
    }
    this.overThreshold.add(actorKey);
    this.lastWarnAt.set(actorKey, now);
    log.warn("acp session actor queue backlog", {
      sessionKey: actorKey,
      pendingCount,
      threshold,
    });
  }

  async run<T>(actorKey: string, op: () => Promise<T>): Promise<T> {
    return this.queue.enqueue(actorKey, op, {
      onEnqueue: () => {
        const next = (this.pendingBySession.get(actorKey) ?? 0) + 1;
        this.pendingBySession.set(actorKey, next);
        this.maybeWarnOnBacklog(actorKey, next);
      },
      onSettle: () => {
        const pending = (this.pendingBySession.get(actorKey) ?? 1) - 1;
        if (pending <= 0) {
          this.pendingBySession.delete(actorKey);
          // Drop rising-edge + rate-limit state when the key drains so the
          // next climb back over threshold emits a fresh warn.
          this.overThreshold.delete(actorKey);
          this.lastWarnAt.delete(actorKey);
        } else {
          this.pendingBySession.set(actorKey, pending);
        }
      },
    });
  }
}
