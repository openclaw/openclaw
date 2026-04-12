import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

const EVENT_RETENTION_MS = 2 * 24 * 60 * 60 * 1_000;
const EVENT_RETENTION_BATCH_SIZE = 256;
const MAX_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_LEASE_TTL_MS = 2 * 60 * 60 * 1_000;
const MIN_HEARTBEAT_INTERVAL_MS = 5_000;
const MIN_LEASE_TTL_MS = 30_000;

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_LEASE_TTL_MS = 20 * 60 * 1_000;
const POOL_EXHAUSTED_RETRY_AFTER_MS = 2_000;

const actorRole = v.union(v.literal("ci"), v.literal("maintainer"));

type BrokerErrorResult = {
  status: "error";
  code: string;
  message: string;
  retryAfterMs?: number;
};

type BrokerOkResult = {
  status: "ok";
};

function normalizeIntervalMs(params: {
  value: number | undefined;
  fallback: number;
  min: number;
  max: number;
}) {
  const value = params.value ?? params.fallback;
  const rounded = Math.floor(value);
  if (!Number.isFinite(rounded) || rounded < params.min || rounded > params.max) {
    return null;
  }
  return rounded;
}

function brokerError(code: string, message: string, retryAfterMs?: number): BrokerErrorResult {
  return retryAfterMs && retryAfterMs > 0
    ? {
        status: "error",
        code,
        message,
        retryAfterMs,
      }
    : {
        status: "error",
        code,
        message,
      };
}

async function insertLeaseEvent(params: {
  ctx: {
    db: {
      insert: (table: "lease_events", value: Record<string, unknown>) => Promise<unknown>;
    };
  };
  kind: string;
  eventType: "acquire" | "acquire_failed" | "release";
  actorRole: "ci" | "maintainer";
  ownerId: string;
  occurredAtMs: number;
  credentialId?: unknown;
  code?: string;
  message?: string;
}) {
  await params.ctx.db.insert("lease_events", {
    kind: params.kind,
    eventType: params.eventType,
    actorRole: params.actorRole,
    ownerId: params.ownerId,
    occurredAtMs: params.occurredAtMs,
    ...(params.credentialId ? { credentialId: params.credentialId } : {}),
    ...(params.code ? { code: params.code } : {}),
    ...(params.message ? { message: params.message } : {}),
  });
}

function sortByLeastRecentlyLeasedThenId(
  rows: Array<{
    _id: unknown;
    lastLeasedAtMs: number;
  }>,
) {
  rows.sort((left, right) => {
    if (left.lastLeasedAtMs !== right.lastLeasedAtMs) {
      return left.lastLeasedAtMs - right.lastLeasedAtMs;
    }
    const leftId = String(left._id);
    const rightId = String(right._id);
    return leftId.localeCompare(rightId);
  });
}

export const acquireLease = internalMutation({
  args: {
    kind: v.string(),
    ownerId: v.string(),
    actorRole,
    leaseTtlMs: v.optional(v.number()),
    heartbeatIntervalMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const nowMs = Date.now();
    const leaseTtlMs = normalizeIntervalMs({
      value: args.leaseTtlMs,
      fallback: DEFAULT_LEASE_TTL_MS,
      min: MIN_LEASE_TTL_MS,
      max: MAX_LEASE_TTL_MS,
    });
    if (!leaseTtlMs) {
      return brokerError(
        "INVALID_LEASE_TTL",
        `leaseTtlMs must be between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS}.`,
      );
    }
    const heartbeatIntervalMs = normalizeIntervalMs({
      value: args.heartbeatIntervalMs,
      fallback: DEFAULT_HEARTBEAT_INTERVAL_MS,
      min: MIN_HEARTBEAT_INTERVAL_MS,
      max: MAX_HEARTBEAT_INTERVAL_MS,
    });
    if (!heartbeatIntervalMs) {
      return brokerError(
        "INVALID_HEARTBEAT_INTERVAL",
        `heartbeatIntervalMs must be between ${MIN_HEARTBEAT_INTERVAL_MS} and ${MAX_HEARTBEAT_INTERVAL_MS}.`,
      );
    }

    const activeRows = await ctx.db
      .query("credential_sets")
      .withIndex("by_kind_status", (q) => q.eq("kind", args.kind).eq("status", "active"))
      .collect();

    const availableRows = activeRows.filter((row) => {
      const lease = row.lease;
      return !lease || lease.expiresAtMs <= nowMs;
    });

    if (availableRows.length === 0) {
      await insertLeaseEvent({
        ctx,
        kind: args.kind,
        eventType: "acquire_failed",
        actorRole: args.actorRole,
        ownerId: args.ownerId,
        occurredAtMs: nowMs,
        code: "POOL_EXHAUSTED",
        message: "No active credential in this kind is currently available.",
      });
      return brokerError(
        "POOL_EXHAUSTED",
        `No available credential for kind "${args.kind}".`,
        POOL_EXHAUSTED_RETRY_AFTER_MS,
      );
    }

    sortByLeastRecentlyLeasedThenId(availableRows);
    const selected = availableRows[0];
    const leaseToken = crypto.randomUUID();

    await ctx.db.patch(selected._id, {
      lease: {
        ownerId: args.ownerId,
        actorRole: args.actorRole,
        leaseToken,
        acquiredAtMs: nowMs,
        heartbeatAtMs: nowMs,
        expiresAtMs: nowMs + leaseTtlMs,
      },
      lastLeasedAtMs: nowMs,
      updatedAtMs: nowMs,
    });

    await insertLeaseEvent({
      ctx,
      kind: args.kind,
      eventType: "acquire",
      actorRole: args.actorRole,
      ownerId: args.ownerId,
      occurredAtMs: nowMs,
      credentialId: selected._id,
    });

    return {
      status: "ok",
      credentialId: selected._id,
      leaseToken,
      payload: selected.payload,
      leaseTtlMs,
      heartbeatIntervalMs,
    };
  },
});

export const heartbeatLease = internalMutation({
  args: {
    kind: v.string(),
    ownerId: v.string(),
    actorRole,
    credentialId: v.id("credential_sets"),
    leaseToken: v.string(),
    leaseTtlMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<BrokerErrorResult | BrokerOkResult> => {
    const nowMs = Date.now();
    const leaseTtlMs = normalizeIntervalMs({
      value: args.leaseTtlMs,
      fallback: DEFAULT_LEASE_TTL_MS,
      min: MIN_LEASE_TTL_MS,
      max: MAX_LEASE_TTL_MS,
    });
    if (!leaseTtlMs) {
      return brokerError(
        "INVALID_LEASE_TTL",
        `leaseTtlMs must be between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS}.`,
      );
    }

    const row = await ctx.db.get(args.credentialId);
    if (!row) {
      return brokerError("CREDENTIAL_NOT_FOUND", "Credential record does not exist.");
    }
    if (row.kind !== args.kind) {
      return brokerError("KIND_MISMATCH", "Credential kind did not match this lease heartbeat.");
    }
    if (row.status !== "active") {
      return brokerError(
        "CREDENTIAL_DISABLED",
        "Credential is disabled and cannot be heartbeated.",
      );
    }
    if (!row.lease) {
      return brokerError("LEASE_NOT_FOUND", "Credential is not currently leased.");
    }
    if (row.lease.ownerId !== args.ownerId || row.lease.leaseToken !== args.leaseToken) {
      return brokerError("LEASE_NOT_OWNER", "Credential lease owner/token mismatch.");
    }
    if (row.lease.expiresAtMs < nowMs) {
      return brokerError("LEASE_EXPIRED", "Credential lease has already expired.");
    }

    await ctx.db.patch(args.credentialId, {
      lease: {
        ...row.lease,
        heartbeatAtMs: nowMs,
        expiresAtMs: nowMs + leaseTtlMs,
      },
      updatedAtMs: nowMs,
    });

    return { status: "ok" };
  },
});

export const releaseLease = internalMutation({
  args: {
    kind: v.string(),
    ownerId: v.string(),
    actorRole,
    credentialId: v.id("credential_sets"),
    leaseToken: v.string(),
  },
  handler: async (ctx, args): Promise<BrokerErrorResult | BrokerOkResult> => {
    const nowMs = Date.now();
    const row = await ctx.db.get(args.credentialId);
    if (!row) {
      return brokerError("CREDENTIAL_NOT_FOUND", "Credential record does not exist.");
    }
    if (row.kind !== args.kind) {
      return brokerError("KIND_MISMATCH", "Credential kind did not match this lease release.");
    }
    if (!row.lease) {
      return { status: "ok" };
    }
    if (row.lease.ownerId !== args.ownerId || row.lease.leaseToken !== args.leaseToken) {
      return brokerError("LEASE_NOT_OWNER", "Credential lease owner/token mismatch.");
    }

    await ctx.db.patch(args.credentialId, {
      lease: undefined,
      updatedAtMs: nowMs,
    });
    await insertLeaseEvent({
      ctx,
      kind: args.kind,
      eventType: "release",
      actorRole: args.actorRole,
      ownerId: args.ownerId,
      occurredAtMs: nowMs,
      credentialId: args.credentialId,
    });
    return { status: "ok" };
  },
});

export const cleanupLeaseEvents = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoffMs = Date.now() - EVENT_RETENTION_MS;
    const staleRows = await ctx.db
      .query("lease_events")
      .withIndex("by_occurredAtMs", (q) => q.lt("occurredAtMs", cutoffMs))
      .take(EVENT_RETENTION_BATCH_SIZE);

    for (const row of staleRows) {
      await ctx.db.delete(row._id);
    }

    if (staleRows.length === EVENT_RETENTION_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.credentials.cleanupLeaseEvents, {});
    }

    return {
      status: "ok",
      deleted: staleRows.length,
      retentionMs: EVENT_RETENTION_MS,
    };
  },
});
