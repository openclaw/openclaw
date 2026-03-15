/**
 * ENGN-5612: Agent spawn audit logging and rate alerts.
 *
 * Tracks per-agent spawn rates and triggers warnings when thresholds
 * are exceeded. Provides queryable spawn history.
 */

import { defaultRuntime } from "../runtime.js";

export type SpawnRateAlertConfig = {
  threshold: number;
  windowMs: number;
};

const DEFAULT_THRESHOLD = 5;
const DEFAULT_WINDOW_MS = 60_000; // 1 minute

let config: SpawnRateAlertConfig = {
  threshold: DEFAULT_THRESHOLD,
  windowMs: DEFAULT_WINDOW_MS,
};

type SpawnEvent = {
  agentId: string;
  timestamp: number;
  runId: string;
  childSessionKey: string;
  label?: string;
};

/** Per-agent index: agentId → array of events (sorted by timestamp). */
const spawnByAgent = new Map<string, SpawnEvent[]>();
const MAX_HISTORY_PER_AGENT = 500;

/** Optional callback for alert delivery (e.g., Slack notification). */
let alertCallback: ((message: string, agentId: string) => void | Promise<void>) | null = null;

export function configureSpawnRateAlert(partial: Partial<SpawnRateAlertConfig>): void {
  if (typeof partial.threshold === "number" && partial.threshold >= 1) {
    config.threshold = Math.floor(partial.threshold);
  }
  if (typeof partial.windowMs === "number" && partial.windowMs > 0) {
    config.windowMs = Math.floor(partial.windowMs);
  }
}

export function setSpawnAlertCallback(
  cb: ((message: string, agentId: string) => void | Promise<void>) | null,
): void {
  alertCallback = cb;
}

function pruneAgentHistory(events: SpawnEvent[], now: number): SpawnEvent[] {
  // Keep events within 1 hour
  const hourAgo = now - 3_600_000;
  const cutIdx = events.findIndex((e) => e.timestamp >= hourAgo);
  const pruned = cutIdx <= 0 ? events : events.slice(cutIdx);
  // Hard cap per agent
  if (pruned.length > MAX_HISTORY_PER_AGENT) {
    return pruned.slice(pruned.length - MAX_HISTORY_PER_AGENT);
  }
  return pruned;
}

export function recordSpawn(params: {
  agentId: string;
  runId: string;
  childSessionKey: string;
  label?: string;
}): void {
  const now = Date.now();
  const event: SpawnEvent = {
    agentId: params.agentId,
    timestamp: now,
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    label: params.label,
  };

  let agentEvents = spawnByAgent.get(params.agentId);
  if (!agentEvents) {
    agentEvents = [];
    spawnByAgent.set(params.agentId, agentEvents);
  }
  agentEvents.push(event);

  // Periodic prune for this agent
  if (agentEvents.length > MAX_HISTORY_PER_AGENT * 1.5) {
    spawnByAgent.set(params.agentId, pruneAgentHistory(agentEvents, now));
    agentEvents = spawnByAgent.get(params.agentId)!;
  }

  // Check rate for this agent (scan only this agent's events)
  const windowStart = now - config.windowMs;
  let recentCount = 0;
  for (let i = agentEvents.length - 1; i >= 0; i--) {
    if (agentEvents[i].timestamp >= windowStart) {
      recentCount++;
    } else {
      break; // Events are sorted by time, no need to go further
    }
  }

  if (recentCount > config.threshold) {
    const message =
      `[spawn-audit] RATE ALERT: Agent "${params.agentId}" has spawned ` +
      `${recentCount} subagents in the last ${Math.round(config.windowMs / 1000)}s ` +
      `(threshold: ${config.threshold}).`;

    defaultRuntime.log(message);

    if (alertCallback) {
      void Promise.resolve(alertCallback(message, params.agentId)).catch(() => {
        // Swallow alert delivery failures
      });
    }
  }
}

export function getSpawnRate(agentId: string, windowMs?: number): number {
  const now = Date.now();
  const window = windowMs ?? config.windowMs;
  const windowStart = now - window;
  const agentEvents = spawnByAgent.get(agentId);
  if (!agentEvents) {
    return 0;
  }
  let count = 0;
  for (let i = agentEvents.length - 1; i >= 0; i--) {
    if (agentEvents[i].timestamp >= windowStart) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

export type SpawnHistoryQuery = {
  agentId?: string;
  windowMs?: number;
  limit?: number;
};

export function querySpawnHistory(query?: SpawnHistoryQuery): SpawnEvent[] {
  const now = Date.now();

  let results: SpawnEvent[];

  if (query?.agentId) {
    const agentEvents = spawnByAgent.get(query.agentId);
    results = agentEvents ? [...agentEvents] : [];
  } else {
    // Merge all agents
    results = [];
    for (const events of spawnByAgent.values()) {
      results.push(...events);
    }
    results.sort((a, b) => a.timestamp - b.timestamp);
  }

  if (query?.windowMs) {
    const windowStart = now - query.windowMs;
    results = results.filter((e) => e.timestamp >= windowStart);
  }

  if (query?.limit && query.limit > 0) {
    results = results.slice(-query.limit);
  }

  return results;
}

export function getSpawnSummary(): Record<string, { perMinute: number; perHour: number }> {
  const now = Date.now();
  const minuteStart = now - 60_000;
  const hourStart = now - 3_600_000;
  const summary: Record<string, { perMinute: number; perHour: number }> = {};

  for (const [agentId, events] of spawnByAgent.entries()) {
    let perMinute = 0;
    let perHour = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      const ts = events[i].timestamp;
      if (ts >= minuteStart) {
        perMinute++;
        perHour++;
      } else if (ts >= hourStart) {
        perHour++;
      } else {
        break;
      }
    }
    if (perHour > 0) {
      summary[agentId] = { perMinute, perHour };
    }
  }

  return summary;
}

export function resetSpawnAuditForTests(): void {
  spawnByAgent.clear();
  alertCallback = null;
  config = {
    threshold: DEFAULT_THRESHOLD,
    windowMs: DEFAULT_WINDOW_MS,
  };
}
