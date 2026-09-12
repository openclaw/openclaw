// Line plugin module implements durable send plan persistence behavior.
import { createHash } from "node:crypto";
import type { messagingApi } from "@line/bot-sdk";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { z } from "zod";
import { getLineRuntime } from "./runtime.js";
import { LINE_RETRY_KEY_TTL_MS } from "./send-retry.js";

const PLAN_VERSION = 1;
const PLAN_NAMESPACE = "outbound-send-plans";
// The authoritative deadline is `firstDispatchedAtMs + LINE_RETRY_KEY_TTL_MS`, read off
// the plan rather than off the queue entry. The store's own TTL runs from the last
// write, so it is given a tail past that deadline: a record that vanishes exactly when
// the window closes leaves reconciliation unable to tell "LINE has forgotten these
// keys" from "this delivery never carried a recorder", and those two need different
// answers. The tail only has to outlast the window, not extend it.
const PLAN_DIAGNOSTIC_RETENTION_MS = 60 * 60 * 1000;
const PLAN_TTL_MS = LINE_RETRY_KEY_TTL_MS + PLAN_DIAGNOSTIC_RETENTION_MS;

/** One platform send: the request LINE saw, under the key that deduplicates it. */
type LineDurablePush = {
  retryKey: string;
  messages: messagingApi.Message[];
};

/**
 * Every push one delivery part will make, written once before the first of them
 * crosses the platform boundary.
 *
 * The whole fan-out is decided before any of it is sent — no LINE message in a
 * part depends on the result of an earlier one — so the record can be complete
 * rather than accumulated. A replay reissues these recorded requests instead of
 * re-rendering the reply, which is what keeps an upgrade across the interruption
 * from putting different content behind a key LINE has already answered. The messages
 * are stored normalized and leave as stored, so a change to normalization between the
 * send and its replay does not move them either.
 */
type LineDurableSendPlan = {
  version: typeof PLAN_VERSION;
  queueId: string;
  partIndex: number;
  partCount: number;
  to: string;
  accountId?: string;
  /**
   * When this plan's retry keys were first handed to LINE. The keys themselves are a
   * timestamp-free hash (`resolveLinePushRetryKey`), and the queue entry's
   * `platformSendStartedAt` is refreshed on every dispatch
   * (`markDeliveryPlatformSendDispatched`), so this record is the only place that
   * knows when LINE's deduplication window actually opened.
   */
  firstDispatchedAtMs: number;
  pushes: LineDurablePush[];
};

/** Refuses a reconciliation whose recorded evidence cannot be trusted to be complete. */
export class LineDurableSendPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LineDurableSendPlanError";
  }
}

/**
 * The plan store refused a part's record and a read confirmed the part has none, so the
 * part can go out without one without contradicting an earlier plan. A record that exists
 * but does not describe this send, or a store that cannot be read, is a different error.
 */
export class LineDurableSendPlanStoreError extends Error {
  constructor(partIndex: number | undefined, cause: unknown) {
    super(
      `LINE durable send plan part ${partIndex} could not be stored: ${formatErrorMessage(cause)}`,
      { cause },
    );
    this.name = "LineDurableSendPlanStoreError";
  }
}

function createPlanStore() {
  return getLineRuntime().state.openBlobStore<Record<string, never>>({
    namespace: PLAN_NAMESPACE,
    maxEntries: 10_000,
    maxBytesPerEntry: 1024 * 1024,
    maxBytesPerNamespace: 64 * 1024 * 1024,
    // Evicting a plan would silently remove the only proof of what was already
    // sent, so a full namespace refuses the new record and keeps the old ones.
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

// Stored bytes are a deserialization boundary: the plan's own fields are parsed,
// and a plan that no longer matches its version or topology is refused rather
// than trusted. A stored message is checked only far enough to be a LINE message
// object, because it is reissued verbatim rather than interpreted here.
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

/**
 * Claims the record for one delivery part, or hands back the one already there.
 *
 * A retry of the same queued send re-renders the reply from live configuration,
 * which can differ from what was already sent. The stored plan wins in that case:
 * the keys are derived from the delivery, so reissuing re-rendered content under
 * them would let LINE answer 409 for a request it never saw and drop the
 * difference. First write wins, and every later attempt replays it.
 */
export async function recordLineDurableSendPlan(params: {
  queueId: string;
  /**
   * The delivery's own part coordinates, passed through rather than defaulted: a
   * substituted index or count records a topology the delivery never had, and both
   * are refused below instead.
   */
  partIndex: number | undefined;
  partCount: number | undefined;
  to: string;
  accountId?: string;
  pushes: LineDurablePush[];
}): Promise<LineDurableSendPlan> {
  const key = planKey(params.queueId, params.partIndex);
  const store = createPlanStore();
  // Typed as the input rather than as a valid plan: the schema below is what decides
  // whether it is one, and pre-declaring it valid would hide a missing part count.
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
  // The record is only worth writing if recovery can read it back. Checking here
  // fails the send before the push crosses the boundary; the same plan rejected
  // on the way out would instead be discovered after the reply was delivered,
  // with nothing left to reconcile against.
  const parsed = planSchema.safeParse(plan);
  if (!parsed.success) {
    throw new LineDurableSendPlanError(
      `LINE durable send plan part ${params.partIndex} cannot be recorded: ${parsed.error.message}`,
    );
  }
  // Everything below stores and compares the parsed plan, not the input: the schema
  // trims `to`, so keeping the raw one would compare a trimmed record against an
  // untrimmed argument on the claim-conflict path.
  const recordable = parsed.data;
  await store.deleteExpired();
  // Claim atomically rather than checking then writing: two attempts at the same part
  // can race, and a lost race that still wrote would put re-rendered content behind
  // keys the winner already used.
  let refusal: { error: unknown } | undefined;
  try {
    if (
      await store.registerIfAbsent(key, new TextEncoder().encode(JSON.stringify(recordable)), {})
    ) {
      return recordable;
    }
  } catch (error) {
    refusal = { error };
  }
  // A refused write does not say this part has no record: the store checks the entry size
  // before it looks for the key. Only this read can say so, and only then may the part go
  // out without one. A read that fails stays the store's own, retryable, error.
  const existing = await store.lookup(key);
  if (!existing) {
    if (refusal) {
      throw new LineDurableSendPlanStoreError(params.partIndex, refusal.error);
    }
    // The record was there a moment ago and is not now. Nothing has been sent yet, so
    // refuse rather than send under keys whose record no longer exists.
    throw new LineDurableSendPlanError(
      `LINE durable send plan part ${params.partIndex} disappeared while being recorded`,
    );
  }
  const recorded = decodePlan(existing.bytes);
  if (recorded.to !== recordable.to) {
    // The keys are derived from the delivery, so a record under this key that names a
    // different recipient is not this send's record and must not be replayed to it.
    throw new LineDurableSendPlanError(
      `LINE durable send plan part ${params.partIndex} was recorded for a different recipient`,
    );
  }
  if (recorded.partCount !== recordable.partCount) {
    // Same reasoning one dimension over. A retry that now plans a different number of
    // parts would pair this stored part with parts the record never described, and the
    // mismatch only surfaces later as an inconsistent topology that cannot be settled.
    throw new LineDurableSendPlanError(
      `LINE durable send plan part ${params.partIndex} was recorded for a different fan-out`,
    );
  }
  if (recorded.accountId !== recordable.accountId) {
    // The dimension deduplication actually runs on: LINE remembers a retry key per
    // channel, so a record claimed under one account says nothing about whether the
    // other account's channel accepted the same key. Replaying it there would deliver
    // a second copy.
    throw new LineDurableSendPlanError(
      `LINE durable send plan part ${params.partIndex} was recorded for a different account`,
    );
  }
  return recorded;
}

/**
 * Loads every recorded part of one delivery. A missing part is refused rather
 * than replayed: core planned it, nothing recorded it, and what it would have
 * said only ever existed inside the interrupted run.
 */
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
    // Unreachable: the caller answers an empty record before it gets here. Kept as a
    // guard rather than an assertion marker so the type holds without one.
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

/** Drops a settled delivery's recorded content once no replay can need it again. */
export async function clearLineDurableSendPlans(queueId: string): Promise<void> {
  const store = createPlanStore();
  await store.deleteExpired();
  const prefix = queuePrefix(queueId);
  const keys = (await store.entries())
    .filter((entry) => entry.key.startsWith(prefix))
    .map((entry) => entry.key);
  await Promise.all(keys.map(async (key) => await store.delete(key)));
}
