import { createHash } from "node:crypto";
import type { messagingApi } from "@line/bot-sdk";
import { z } from "zod";
import { getLineRuntime } from "./runtime.js";
import { LINE_RETRY_KEY_TTL_MS } from "./send-retry.js";

const PLAN_VERSION = 1;
const PLAN_NAMESPACE = "outbound-send-plans";
// Outlives LINE's retry-key window so an expired record is not mistaken for a missing one.
const PLAN_DIAGNOSTIC_RETENTION_MS = 60 * 60 * 1000;
const PLAN_TTL_MS = LINE_RETRY_KEY_TTL_MS + PLAN_DIAGNOSTIC_RETENTION_MS;

type LineDurablePush = {
  retryKey: string;
  messages: messagingApi.Message[];
};

/**
 * Every push one delivery part will make, written before the first one is sent. A replay
 * reissues these requests instead of re-rendering, so content behind an accepted retry
 * key cannot change across an upgrade or config change.
 */
type LineDurableSendPlan = {
  version: typeof PLAN_VERSION;
  queueId: string;
  partIndex: number;
  partCount: number;
  to: string;
  accountId?: string;
  // The queue entry's dispatch time is refreshed on every attempt; this is the first.
  firstDispatchedAtMs: number;
  pushes: LineDurablePush[];
};

export class LineDurableSendPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LineDurableSendPlanError";
  }
}

const CLAIM_IDENTITY = [
  ["to", "recipient"],
  ["partCount", "fan-out"],
  ["accountId", "account"],
] as const;

function createPlanStore() {
  return getLineRuntime().state.openBlobStore<Record<string, never>>({
    namespace: PLAN_NAMESPACE,
    maxEntries: 10_000,
    maxBytesPerEntry: 1024 * 1024,
    maxBytesPerNamespace: 64 * 1024 * 1024,
    // Evicting a plan would drop the only record of what was already sent.
    overflowPolicy: "reject-new",
    defaultTtlMs: PLAN_TTL_MS,
  });
}

function requireIndex(value: number | undefined, label: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new LineDurableSendPlanError(
      `LINE durable send plan ${label} must be a non-negative integer`,
    );
  }
  return value;
}

function queuePrefix(queueId: string): string {
  const normalized = queueId.trim();
  if (!normalized) {
    throw new LineDurableSendPlanError("LINE durable send plan requires a queue id");
  }
  return `${createHash("sha256").update(normalized).digest("hex")}.`;
}

function planKey(queueId: string, partIndex: number | undefined): string {
  return `${queuePrefix(queueId)}${requireIndex(partIndex, "part index")}`;
}

// Stored messages are reissued verbatim, so they are only checked to be LINE messages.
const lineMessageSchema = z.custom<messagingApi.Message>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string",
);

const planSchema = z
  .object({
    version: z.literal(PLAN_VERSION),
    queueId: z.string().trim().min(1),
    partIndex: z.number().int().nonnegative(),
    partCount: z.number().int().positive(),
    to: z.string().trim().min(1),
    accountId: z.string().optional(),
    firstDispatchedAtMs: z.number().int().positive(),
    pushes: z
      .array(
        z.object({
          retryKey: z.string().trim().min(1),
          messages: z.array(lineMessageSchema).min(1),
        }),
      )
      .min(1),
  })
  .refine((plan) => plan.partIndex < plan.partCount, {
    message: "part index must be below the part count",
  });

function decodePlan(bytes: Uint8Array): LineDurableSendPlan {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new LineDurableSendPlanError("LINE durable send plan is invalid JSON");
  }
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) {
    throw new LineDurableSendPlanError("LINE durable send plan is invalid");
  }
  return parsed.data;
}

/** Claims the record for one delivery part, or returns the one an earlier attempt wrote. */
export async function recordLineDurableSendPlan(params: {
  queueId: string;
  // Passed through rather than defaulted, so a route that lost them is refused.
  partIndex: number | undefined;
  partCount: number | undefined;
  to: string;
  accountId?: string;
  pushes: LineDurablePush[];
}): Promise<LineDurableSendPlan> {
  const key = planKey(params.queueId, params.partIndex);
  const store = createPlanStore();
  const plan = {
    version: PLAN_VERSION,
    queueId: params.queueId,
    partIndex: params.partIndex,
    partCount: params.partCount,
    to: params.to,
    ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
    firstDispatchedAtMs: Date.now(),
    pushes: params.pushes,
  };
  // Validate before sending: a record recovery cannot read back is worth nothing.
  const parsed = planSchema.safeParse(plan);
  if (!parsed.success) {
    throw new LineDurableSendPlanError(
      `LINE durable send plan part ${params.partIndex} cannot be recorded: ${parsed.error.message}`,
    );
  }
  const recordable = parsed.data;
  await store.deleteExpired();
  if (await store.registerIfAbsent(key, new TextEncoder().encode(JSON.stringify(recordable)), {})) {
    return recordable;
  }
  const existing = await store.lookup(key);
  if (!existing) {
    throw new LineDurableSendPlanError(
      `LINE durable send plan part ${params.partIndex} disappeared while being recorded`,
    );
  }
  const recorded = decodePlan(existing.bytes);
  // The stored content wins over a re-render, but a record for another recipient, part
  // count or account (LINE deduplicates retry keys per channel) is not this send's record.
  const conflict = CLAIM_IDENTITY.find(([field]) => recorded[field] !== recordable[field]);
  if (conflict) {
    throw new LineDurableSendPlanError(
      `LINE durable send plan part ${params.partIndex} was recorded for a different ${conflict[1]}`,
    );
  }
  return recorded;
}

/** Loads every recorded part of one delivery, refusing one with a part missing. */
export async function loadLineDurableSendPlans(queueId: string): Promise<LineDurableSendPlan[]> {
  const store = createPlanStore();
  const prefix = queuePrefix(queueId);
  const keys = (await store.entries())
    .filter((entry) => entry.key.startsWith(prefix))
    .map((entry) => entry.key);
  if (keys.length === 0) {
    return [];
  }
  const plans = await Promise.all(
    keys.map(async (key) => {
      const entry = await store.lookup(key);
      if (!entry) {
        throw new LineDurableSendPlanError(
          "LINE durable send plan disappeared during reconciliation",
        );
      }
      const plan = decodePlan(entry.bytes);
      if (key !== planKey(plan.queueId, plan.partIndex) || plan.queueId !== queueId.trim()) {
        throw new LineDurableSendPlanError("LINE durable send plan key is invalid");
      }
      return plan;
    }),
  );
  assertCompletePartTopology(plans);
  return plans.toSorted((left, right) => left.partIndex - right.partIndex);
}

function assertCompletePartTopology(plans: readonly LineDurableSendPlan[]): void {
  const [first] = plans;
  if (!first) {
    throw new LineDurableSendPlanError("LINE durable send plan has no recorded parts");
  }
  const partCount = first.partCount;
  if (plans.some((plan) => plan.partCount !== partCount)) {
    throw new LineDurableSendPlanError("LINE durable send plan part topology is inconsistent");
  }
  const recorded = new Set(plans.map((plan) => plan.partIndex));
  const missing = Array.from({ length: partCount }, (_, partIndex) => partIndex).filter(
    (partIndex) => !recorded.has(partIndex),
  );
  if (missing.length > 0) {
    throw new LineDurableSendPlanError(
      `LINE ambiguous delivery is missing recorded parts: ${missing.join(", ")}`,
    );
  }
}

export async function clearLineDurableSendPlans(queueId: string): Promise<void> {
  const store = createPlanStore();
  await store.deleteExpired();
  const prefix = queuePrefix(queueId);
  const keys = (await store.entries())
    .filter((entry) => entry.key.startsWith(prefix))
    .map((entry) => entry.key);
  await Promise.all(keys.map(async (key) => await store.delete(key)));
}
