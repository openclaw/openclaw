/**
 * ENGN-5609: Gateway-level concurrency cap for API calls.
 *
 * Provides a semaphore that limits total concurrent subagent spawns across
 * all agents. Requests exceeding the cap are queued with backpressure.
 * Per-agent fair-share enforcement ensures no single agent monopolizes slots.
 */

import { defaultRuntime } from "../runtime.js";

export type ConcurrencyGateConfig = {
  maxGlobalConcurrent: number;
};

type QueueEntry = {
  agentId: string;
  resolve: () => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_MAX_GLOBAL_CONCURRENT = 10;
const QUEUE_TIMEOUT_MS = 30_000;

let maxSlots = DEFAULT_MAX_GLOBAL_CONCURRENT;
let activeCount = 0;
const activeByAgent = new Map<string, number>();
const queue: QueueEntry[] = [];

export function configureConcurrencyGate(config: Partial<ConcurrencyGateConfig>): void {
  if (typeof config.maxGlobalConcurrent === "number" && config.maxGlobalConcurrent >= 1) {
    maxSlots = Math.floor(config.maxGlobalConcurrent);
  }
}

export function getConcurrencyStats(): {
  active: number;
  max: number;
  queued: number;
  activeByAgent: Record<string, number>;
} {
  const byAgent: Record<string, number> = {};
  for (const [agentId, count] of activeByAgent.entries()) {
    byAgent[agentId] = count;
  }
  return {
    active: activeCount,
    max: maxSlots,
    queued: queue.length,
    activeByAgent: byAgent,
  };
}

function computeFairShare(): number {
  // Only count agents with active slots for a stable denominator
  const agentCount = Math.max(1, activeByAgent.size);
  return Math.max(1, Math.floor(maxSlots / agentCount));
}

function isAgentOverFairShare(agentId: string): boolean {
  const current = activeByAgent.get(agentId) ?? 0;
  return current >= computeFairShare();
}

function removeFromQueue(entry: QueueEntry): void {
  const idx = queue.indexOf(entry);
  if (idx !== -1) {
    queue.splice(idx, 1);
  }
}

function tryDrainQueue(): void {
  while (queue.length > 0 && activeCount < maxSlots) {
    // Prefer the queued agent with the fewest active slots (fair-share priority).
    // Among ties, FIFO order is preserved.
    let bestIdx = 0;
    let bestActive = activeByAgent.get(queue[0].agentId) ?? 0;
    for (let i = 1; i < queue.length; i++) {
      const a = activeByAgent.get(queue[i].agentId) ?? 0;
      if (a < bestActive) {
        bestIdx = i;
        bestActive = a;
      }
    }
    const entry = queue.splice(bestIdx, 1)[0];
    clearTimeout(entry.timer);
    activeCount++;
    activeByAgent.set(entry.agentId, (activeByAgent.get(entry.agentId) ?? 0) + 1);
    entry.resolve();
  }
}

export async function acquireConcurrencySlot(agentId: string): Promise<void> {
  if (activeCount < maxSlots && !isAgentOverFairShare(agentId)) {
    activeCount++;
    activeByAgent.set(agentId, (activeByAgent.get(agentId) ?? 0) + 1);
    defaultRuntime.log(
      `[concurrency-gate] Slot acquired agent=${agentId} active=${activeCount}/${maxSlots}`,
    );
    return;
  }

  return new Promise<void>((resolve, reject) => {
    const entry: QueueEntry = {
      agentId,
      resolve,
      reject,
      enqueuedAt: Date.now(),
      timer: setTimeout(() => {
        removeFromQueue(entry);
        reject(new Error("Concurrency gate queue timeout exceeded"));
      }, QUEUE_TIMEOUT_MS),
    };
    // Don't hold the process open for queue timeouts
    if (typeof entry.timer === "object" && "unref" in entry.timer) {
      entry.timer.unref();
    }
    queue.push(entry);
    defaultRuntime.log(
      `[concurrency-gate] Queued agent=${agentId} active=${activeCount}/${maxSlots} queued=${queue.length}`,
    );
  });
}

export function releaseConcurrencySlot(agentId: string): void {
  if (activeCount > 0) {
    activeCount--;
  }
  const current = activeByAgent.get(agentId) ?? 0;
  if (current <= 1) {
    activeByAgent.delete(agentId);
  } else {
    activeByAgent.set(agentId, current - 1);
  }
  defaultRuntime.log(
    `[concurrency-gate] Slot released agent=${agentId} active=${activeCount}/${maxSlots}`,
  );
  tryDrainQueue();
}

export function resetConcurrencyGateForTests(): void {
  // Clear all pending timers
  for (const entry of queue) {
    clearTimeout(entry.timer);
  }
  activeCount = 0;
  activeByAgent.clear();
  queue.length = 0;
  maxSlots = DEFAULT_MAX_GLOBAL_CONCURRENT;
}
