import { createHash } from "node:crypto";
import { createPluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { MatrixAuth } from "../client/types.js";
import { LogService } from "../sdk/logger.js";
import { withMatrixSqliteStateEnvAsync } from "../sqlite-state.js";

const MATRIX_PLUGIN_ID = "matrix";
const INBOUND_DEDUPE_NAMESPACE = "inbound-dedupe";
const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type StoredMatrixInboundDedupeEntry = {
  roomId: string;
  eventId: string;
  ts: number;
};

export type MatrixInboundEventDeduper = {
  claimEvent: (params: { roomId: string; eventId: string }) => boolean;
  commitEvent: (params: { roomId: string; eventId: string }) => Promise<void>;
  releaseEvent: (params: { roomId: string; eventId: string }) => void;
  flush: () => Promise<void>;
  stop: () => Promise<void>;
};

function normalizeEventPart(value: string): string {
  return value.trim();
}

function buildEventKey(params: { auth: MatrixAuth; roomId: string; eventId: string }): string {
  const accountId = normalizeEventPart(params.auth.accountId) || "default";
  const roomId = normalizeEventPart(params.roomId);
  const eventId = normalizeEventPart(params.eventId);
  if (!roomId || !eventId) {
    return "";
  }
  const digest = createHash("sha256")
    .update(accountId)
    .update("\0")
    .update(roomId)
    .update("\0")
    .update(eventId)
    .digest("hex");
  return `${accountId}:${digest}`;
}

function normalizeTimestamp(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return null;
  }
  return Math.max(0, Math.floor(raw));
}

function pruneSeenEvents(params: {
  seen: Map<string, number>;
  ttlMs: number;
  maxEntries: number;
  nowMs: number;
}) {
  const { seen, ttlMs, maxEntries, nowMs } = params;
  if (ttlMs > 0) {
    const cutoff = nowMs - ttlMs;
    for (const [key, ts] of seen) {
      if (ts < cutoff) {
        seen.delete(key);
      }
    }
  }
  const max = Math.max(0, Math.floor(maxEntries));
  if (max <= 0) {
    seen.clear();
    return;
  }
  while (seen.size > max) {
    const oldestKey = [...seen.entries()].toSorted(
      (a, b) => a[1] - b[1] || a[0].localeCompare(b[0]),
    )[0]?.[0];
    if (typeof oldestKey !== "string") {
      break;
    }
    seen.delete(oldestKey);
  }
}

export async function createMatrixInboundEventDeduper(params: {
  auth: MatrixAuth;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  storagePath?: string;
  ttlMs?: number;
  maxEntries?: number;
  nowMs?: () => number;
}): Promise<MatrixInboundEventDeduper> {
  const nowMs = params.nowMs ?? (() => Date.now());
  const ttlMs =
    typeof params.ttlMs === "number" && Number.isFinite(params.ttlMs)
      ? Math.max(0, Math.floor(params.ttlMs))
      : DEFAULT_TTL_MS;
  const maxEntries =
    typeof params.maxEntries === "number" && Number.isFinite(params.maxEntries)
      ? Math.max(0, Math.floor(params.maxEntries))
      : DEFAULT_MAX_ENTRIES;
  const store = createPluginStateKeyedStore<StoredMatrixInboundDedupeEntry>(MATRIX_PLUGIN_ID, {
    namespace: INBOUND_DEDUPE_NAMESPACE,
    maxEntries: DEFAULT_MAX_ENTRIES,
  });

  const seen = new Map<string, number>();
  const pending = new Set<string>();

  try {
    const entries = await withMatrixSqliteStateEnvAsync(params, () => store.entries());
    for (const entry of entries) {
      const value = entry.value;
      if (!value) {
        continue;
      }
      const key = entry.key.trim();
      const roomId = typeof value.roomId === "string" ? value.roomId.trim() : "";
      const eventId = typeof value.eventId === "string" ? value.eventId.trim() : "";
      const ts = normalizeTimestamp(value.ts);
      if (!key || ts === null) {
        continue;
      }
      const expectedKey = buildEventKey({ auth: params.auth, roomId, eventId });
      if (expectedKey === key) {
        seen.set(key, ts);
      }
    }
    pruneSeenEvents({ seen, ttlMs, maxEntries, nowMs: nowMs() });
  } catch (err) {
    LogService.warn("MatrixInboundDedupe", "Failed loading Matrix inbound dedupe store:", err);
  }

  return {
    claimEvent: ({ roomId, eventId }) => {
      const key = buildEventKey({ auth: params.auth, roomId, eventId });
      if (!key) {
        return true;
      }
      pruneSeenEvents({ seen, ttlMs, maxEntries, nowMs: nowMs() });
      if (seen.has(key) || pending.has(key)) {
        return false;
      }
      pending.add(key);
      return true;
    },
    commitEvent: async ({ roomId, eventId }) => {
      const key = buildEventKey({ auth: params.auth, roomId, eventId });
      if (!key) {
        return;
      }
      pending.delete(key);
      const ts = nowMs();
      seen.delete(key);
      seen.set(key, ts);
      pruneSeenEvents({ seen, ttlMs, maxEntries, nowMs: nowMs() });
      await withMatrixSqliteStateEnvAsync(params, () =>
        store.register(
          key,
          {
            roomId: normalizeEventPart(roomId),
            eventId: normalizeEventPart(eventId),
            ts,
          },
          ttlMs > 0 ? { ttlMs } : undefined,
        ),
      );
    },
    releaseEvent: ({ roomId, eventId }) => {
      const key = buildEventKey({ auth: params.auth, roomId, eventId });
      if (!key) {
        return;
      }
      pending.delete(key);
    },
    flush: async () => {},
    stop: async () => {},
  };
}
