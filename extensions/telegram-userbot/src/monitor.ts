/**
 * Health monitoring module for the telegram-userbot channel.
 *
 * Tracks per-account metric counters (messages sent/received, errors,
 * flood waits, reconnects) and provides a probe implementation that
 * verifies the MTProto connection by calling getMe().
 */

import { getConnectionManager } from "./channel.js";

// ---------------------------------------------------------------------------
// Metric counters
// ---------------------------------------------------------------------------

export type UserbotMetrics = {
  messagesSent: number;
  messagesReceived: number;
  errors: number;
  floodWaits: number;
  reconnects: number;
};

const metrics = new Map<string, UserbotMetrics>();

function ensureMetrics(accountId: string): UserbotMetrics {
  let m = metrics.get(accountId);
  if (!m) {
    m = {
      messagesSent: 0,
      messagesReceived: 0,
      errors: 0,
      floodWaits: 0,
      reconnects: 0,
    };
    metrics.set(accountId, m);
  }
  return m;
}

export function incrementMetric(accountId: string, key: keyof UserbotMetrics, amount = 1): void {
  ensureMetrics(accountId)[key] += amount;
}

export function getMetrics(accountId: string): Readonly<UserbotMetrics> {
  return { ...ensureMetrics(accountId) };
}

export function resetMetrics(accountId: string): void {
  metrics.delete(accountId);
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

export type ProbeResult = {
  ok: boolean;
  username?: string;
  userId?: number;
  latencyMs?: number;
  error?: string;
};

/**
 * Probe the connection health by calling getMe() and measuring latency.
 */
export async function probeConnection(accountId: string, timeoutMs = 10_000): Promise<ProbeResult> {
  const manager = getConnectionManager(accountId);
  if (!manager) {
    return { ok: false, error: "No connection manager for this account" };
  }
  const client = manager.getClient();
  if (!client?.isConnected()) {
    return { ok: false, error: "Client is not connected" };
  }

  const start = performance.now();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const me = await client.getMe();
    clearTimeout(timer);

    const latencyMs = Math.round(performance.now() - start);
    return {
      ok: true,
      username: me.username ?? undefined,
      userId: me.id ? Number(me.id) : undefined,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      latencyMs,
    };
  }
}
