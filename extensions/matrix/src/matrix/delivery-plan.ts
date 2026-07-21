// Matrix-owned durable event plans make timeline replay idempotent across process restarts.
import { createHash } from "node:crypto";
import type {
  ChannelMessageUnknownSendContext,
  ChannelMessageUnknownSendReconciliationResult,
  MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";
import { getMatrixRuntime } from "../runtime.js";
import { MATRIX_DURABLE_DELIVERY_PROTOCOL } from "./durable-delivery.js";
import type { MatrixClient } from "./sdk.js";
import { withResolvedMatrixSendClient } from "./send/client.js";
import { resolveMatrixRoomId } from "./send/targets.js";
import type { MatrixOutboundContent } from "./send/types.js";

const DELIVERY_PLAN_VERSION = 2;
const DELIVERY_PLAN_NAMESPACE = "outbound-delivery-plans";
const DELIVERY_PLAN_MAX_ENTRIES = 10_000;

class MatrixDeliveryPlanInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatrixDeliveryPlanInvariantError";
  }
}

export type MatrixPlannedEvent = {
  transactionId: string;
  receiptKind: MessageReceiptPartKind;
  content: MatrixOutboundContent;
};

export type MatrixDeliveryPlan = {
  kind: "plan";
  version: typeof DELIVERY_PLAN_VERSION;
  queueId: string;
  queueStateDir?: string;
  accountId: string;
  roomId: string;
  wireEventType: "m.room.message" | "m.room.encrypted";
  transactionScopeId: string;
  payloadIndex: number;
  partIndex: number;
  eventCount: number;
  createdAt: number;
  dispatchStarted: boolean;
  events: MatrixPlannedEvent[];
};

export type MatrixDeliveryPlanRegistration = {
  plan: MatrixDeliveryPlan;
  created: boolean;
};

export type MatrixDeliveryIdentity = {
  queueId: string;
  payloadIndex: number;
  partIndex: number;
};

export type MatrixDeliveryPlanDispatchState = "absent" | "not_started" | "started";

function createDeliveryPlanStore() {
  return getMatrixRuntime().state.openKeyedStore<MatrixDeliveryPlan>({
    namespace: DELIVERY_PLAN_NAMESPACE,
    maxEntries: DELIVERY_PLAN_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

function requireDeliveryIndex(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Matrix durable delivery ${label} must be a non-negative integer`);
  }
  return value;
}

function queueDigest(queueId: string): string {
  return createHash("sha256").update(queueId).digest("hex");
}

function planPrefix(identity: MatrixDeliveryIdentity): string {
  const payloadIndex = requireDeliveryIndex(identity.payloadIndex, "payload index");
  const partIndex = requireDeliveryIndex(identity.partIndex, "part index");
  return `${queueDigest(identity.queueId)}.${payloadIndex}.${partIndex}`;
}

function payloadPrefix(queueId: string, payloadIndex: number): string {
  return `${queueDigest(queueId)}.${requireDeliveryIndex(payloadIndex, "payload index")}.`;
}

function queuePrefix(queueId: string): string {
  return `${queueDigest(queueId)}.`;
}

function planHeaderKey(identity: MatrixDeliveryIdentity): string {
  return `${planPrefix(identity)}.plan`;
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

const RECEIPT_KINDS = new Set<MessageReceiptPartKind>([
  "text",
  "media",
  "voice",
  "poll",
  "card",
  "preview",
  "unknown",
]);

function isPlannedEvent(value: unknown): value is MatrixPlannedEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const event = value as Partial<MatrixPlannedEvent>;
  return (
    typeof event.transactionId === "string" &&
    Boolean(event.transactionId.trim()) &&
    typeof event.receiptKind === "string" &&
    RECEIPT_KINDS.has(event.receiptKind as MessageReceiptPartKind) &&
    Boolean(event.content) &&
    typeof event.content === "object"
  );
}

function isDeliveryPlan(value: unknown): value is MatrixDeliveryPlan {
  if (!value || typeof value !== "object") {
    return false;
  }
  const plan = value as Partial<MatrixDeliveryPlan>;
  return (
    plan.kind === "plan" &&
    plan.version === DELIVERY_PLAN_VERSION &&
    typeof plan.queueId === "string" &&
    Boolean(plan.queueId.trim()) &&
    (plan.queueStateDir === undefined ||
      (typeof plan.queueStateDir === "string" && Boolean(plan.queueStateDir.trim()))) &&
    Number.isSafeInteger(plan.payloadIndex) &&
    (plan.payloadIndex ?? -1) >= 0 &&
    Number.isSafeInteger(plan.partIndex) &&
    (plan.partIndex ?? -1) >= 0 &&
    Number.isSafeInteger(plan.eventCount) &&
    (plan.eventCount ?? 0) > 0 &&
    Array.isArray(plan.events) &&
    plan.events.length === plan.eventCount &&
    plan.events.every(isPlannedEvent) &&
    typeof plan.accountId === "string" &&
    typeof plan.roomId === "string" &&
    Boolean(plan.roomId.trim()) &&
    (plan.wireEventType === "m.room.message" || plan.wireEventType === "m.room.encrypted") &&
    typeof plan.transactionScopeId === "string" &&
    Boolean(plan.transactionScopeId.trim()) &&
    typeof plan.createdAt === "number" &&
    Number.isFinite(plan.createdAt) &&
    typeof plan.dispatchStarted === "boolean"
  );
}

export function createMatrixDeliveryTransactionId(
  identity: MatrixDeliveryIdentity,
  eventIndex: number,
): string {
  const digest = createHash("sha256")
    .update(identity.queueId)
    .update("\0")
    .update(String(requireDeliveryIndex(identity.payloadIndex, "payload index")))
    .update("\0")
    .update(String(requireDeliveryIndex(identity.partIndex, "part index")))
    .update("\0")
    .update(String(requireDeliveryIndex(eventIndex, "event index")))
    .digest("base64url");
  return `oc_${digest}`;
}

export async function loadMatrixDeliveryPlan(params: {
  identity: MatrixDeliveryIdentity;
  accountId?: string;
  roomId: string;
  transactionScopeId: string;
  wireEventType: "m.room.message" | "m.room.encrypted";
}): Promise<MatrixDeliveryPlan | null> {
  const store = createDeliveryPlanStore();
  const plan = await store.lookup(planHeaderKey(params.identity));
  if (plan === undefined) {
    return null;
  }
  if (!isDeliveryPlan(plan)) {
    throw new MatrixDeliveryPlanInvariantError("Matrix durable delivery plan is invalid");
  }
  if (
    plan.queueId !== params.identity.queueId ||
    plan.accountId !== (params.accountId ?? "") ||
    plan.payloadIndex !== params.identity.payloadIndex ||
    plan.partIndex !== params.identity.partIndex
  ) {
    throw new MatrixDeliveryPlanInvariantError(
      "Matrix durable delivery plan identity no longer matches the active account",
    );
  }
  if (plan.roomId !== params.roomId) {
    if (plan.dispatchStarted) {
      throw new MatrixDeliveryPlanInvariantError(
        "Matrix durable delivery room changed after timeline dispatch",
      );
    }
    // A room alias may remap between attempts. Before dispatch, its old room
    // binding has no remote side effect and must not strand the queued message.
    await store.delete(planHeaderKey(params.identity));
    return null;
  }
  if (plan.transactionScopeId !== params.transactionScopeId) {
    if (plan.dispatchStarted) {
      throw new MatrixDeliveryPlanInvariantError(
        "Matrix durable delivery transaction scope changed after timeline dispatch",
      );
    }
    // A token or device rotation may legitimately change the homeserver's
    // transaction scope. Before dispatch, no remote idempotency key was used.
    await store.delete(planHeaderKey(params.identity));
    return null;
  }
  if (plan.wireEventType !== params.wireEventType) {
    if (plan.dispatchStarted) {
      throw new MatrixDeliveryPlanInvariantError(
        "Matrix durable delivery plan endpoint changed after timeline dispatch",
      );
    }
    // No timeline request could have started, so an encryption transition may
    // discard this endpoint-bound plan and rebuild it without duplicate risk.
    await store.delete(planHeaderKey(params.identity));
    return null;
  }
  return cloneJson(plan);
}

export async function persistMatrixDeliveryPlan(params: {
  identity: MatrixDeliveryIdentity;
  queueStateDir?: string;
  accountId?: string;
  roomId: string;
  transactionScopeId: string;
  wireEventType: "m.room.message" | "m.room.encrypted";
  events: readonly Omit<MatrixPlannedEvent, "transactionId">[];
}): Promise<MatrixDeliveryPlanRegistration> {
  if (params.events.length === 0) {
    throw new Error("Matrix durable delivery plan must contain at least one event");
  }
  await ensureMatrixDeliveryPlanGarbageCollection();
  const store = createDeliveryPlanStore();
  const events = params.events.map((event, eventIndex) => ({
    transactionId: createMatrixDeliveryTransactionId(params.identity, eventIndex),
    receiptKind: event.receiptKind,
    content: cloneJson(event.content),
  }));
  const plan: MatrixDeliveryPlan = {
    kind: "plan",
    version: DELIVERY_PLAN_VERSION,
    queueId: params.identity.queueId,
    ...(params.queueStateDir !== undefined ? { queueStateDir: params.queueStateDir } : {}),
    accountId: params.accountId ?? "",
    roomId: params.roomId,
    wireEventType: params.wireEventType,
    transactionScopeId: params.transactionScopeId,
    payloadIndex: requireDeliveryIndex(params.identity.payloadIndex, "payload index"),
    partIndex: requireDeliveryIndex(params.identity.partIndex, "part index"),
    eventCount: events.length,
    createdAt: Date.now(),
    dispatchStarted: false,
    events,
  };
  const inserted = await store.registerIfAbsent(planHeaderKey(params.identity), plan);
  if (inserted) {
    return { plan, created: true };
  }
  // The first complete plan wins. Concurrent or retried writers must reuse its
  // exact content and transaction ids before any Matrix timeline PUT begins.
  const existing = await loadMatrixDeliveryPlan({
    identity: params.identity,
    accountId: params.accountId,
    roomId: params.roomId,
    transactionScopeId: params.transactionScopeId,
    wireEventType: params.wireEventType,
  });
  if (!existing) {
    throw new Error("Matrix durable delivery plan disappeared after immutable registration");
  }
  return { plan: existing, created: false };
}

export async function markMatrixDeliveryPlanDispatchStarted(
  identity: MatrixDeliveryIdentity,
): Promise<void> {
  const store = createDeliveryPlanStore();
  const key = planHeaderKey(identity);
  const plan = await store.lookup(key);
  if (!isDeliveryPlan(plan)) {
    throw new MatrixDeliveryPlanInvariantError(
      "Matrix durable delivery plan disappeared before timeline dispatch",
    );
  }
  if (plan.dispatchStarted) {
    return;
  }
  await store.register(key, { ...cloneJson(plan), dispatchStarted: true });
}

/** Reset only when the SDK proves its final endpoint guard rejected before timeline I/O. */
export async function resetMatrixDeliveryPlanAfterRejectedDispatch(
  identity: MatrixDeliveryIdentity,
): Promise<void> {
  const store = createDeliveryPlanStore();
  const key = planHeaderKey(identity);
  const plan = await store.lookup(key);
  if (!isDeliveryPlan(plan)) {
    throw new MatrixDeliveryPlanInvariantError(
      "Matrix durable delivery plan disappeared during rejected dispatch",
    );
  }
  if (!plan.dispatchStarted) {
    return;
  }
  await store.register(key, { ...cloneJson(plan), dispatchStarted: false });
}

/** Read the durable dispatch marker used to classify failures across retries. */
export async function resolveMatrixDeliveryPlanDispatchState(
  identity: MatrixDeliveryIdentity,
): Promise<MatrixDeliveryPlanDispatchState> {
  const plan = await createDeliveryPlanStore().lookup(planHeaderKey(identity));
  if (plan === undefined) {
    return "absent";
  }
  if (
    !isDeliveryPlan(plan) ||
    plan.queueId !== identity.queueId ||
    plan.payloadIndex !== identity.payloadIndex ||
    plan.partIndex !== identity.partIndex
  ) {
    throw new MatrixDeliveryPlanInvariantError("Matrix durable delivery plan identity is invalid");
  }
  return plan.dispatchStarted ? "started" : "not_started";
}

export type MatrixDeliveryPlanPruneResult = {
  deleted: number;
  retained: number;
  invalid: number;
};

/** Delete plugin-owned plans only after the authoritative core queue is terminal. */
export async function pruneMatrixTerminalDeliveryPlans(): Promise<MatrixDeliveryPlanPruneResult> {
  const runtime = getMatrixRuntime();
  const getQueueStatus = runtime.state.getOutboundDeliveryQueueStatus;
  if (!getQueueStatus) {
    throw new Error("Matrix durable delivery plan cleanup requires queue status support");
  }
  const store = createDeliveryPlanStore();
  const entries = await store.entries();
  const statuses = new Map<string, "pending" | "terminal" | "absent">();
  const deletions: string[] = [];
  let retained = 0;
  let invalid = 0;

  for (const entry of entries) {
    if (!entry.key.endsWith(".plan") || !isDeliveryPlan(entry.value)) {
      invalid += 1;
      continue;
    }
    const plan = entry.value;
    if (
      entry.key !==
      planHeaderKey({
        queueId: plan.queueId,
        payloadIndex: plan.payloadIndex,
        partIndex: plan.partIndex,
      })
    ) {
      invalid += 1;
      continue;
    }
    const queueLocationKey = JSON.stringify([plan.queueId, plan.queueStateDir]);
    let status = statuses.get(queueLocationKey);
    if (!status) {
      status = await getQueueStatus(plan.queueId, plan.queueStateDir);
      statuses.set(queueLocationKey, status);
    }
    if (status === "pending") {
      retained += 1;
    } else {
      // Core never replays an id after its canonical row becomes terminal or is
      // ack-deleted. Post-ack commit hooks may still run, but cannot resend it.
      deletions.push(entry.key);
    }
  }

  await Promise.all(deletions.map(async (key) => await store.delete(key)));
  return { deleted: deletions.length, retained, invalid };
}

let initialPlanPrune: Promise<MatrixDeliveryPlanPruneResult> | undefined;

function invalidateMatrixDeliveryPlanGarbageCollection(): void {
  initialPlanPrune = undefined;
}

/** Run the full orphan sweep once per process; retry it after transient failures. */
export async function ensureMatrixDeliveryPlanGarbageCollection(): Promise<MatrixDeliveryPlanPruneResult> {
  const active = initialPlanPrune ?? pruneMatrixTerminalDeliveryPlans();
  initialPlanPrune = active;
  try {
    return await active;
  } catch (error) {
    if (initialPlanPrune === active) {
      initialPlanPrune = undefined;
    }
    throw error;
  }
}

export async function deleteMatrixDeliveryPlansForPayload(params: {
  queueId: string;
  payloadIndex: number;
}): Promise<void> {
  const store = createDeliveryPlanStore();
  const prefix = payloadPrefix(params.queueId, params.payloadIndex);
  try {
    const entries = await store.entries();
    await Promise.all(
      entries
        .filter((entry) => entry.key.startsWith(prefix))
        .map(async (entry) => await store.delete(entry.key)),
    );
  } catch (error) {
    // Re-arm the sweep so the next send retries terminal cleanup instead of
    // letting transient store failures accumulate immutable message plans.
    invalidateMatrixDeliveryPlanGarbageCollection();
    throw error;
  }
}

export async function cleanupMatrixDeliveryPlansAfterTerminalFailure(ctx: {
  queueId: string;
  deliveryQueueStateDir?: string;
}): Promise<void> {
  const store = createDeliveryPlanStore();
  const prefix = queuePrefix(ctx.queueId);
  try {
    const entries = await store.entries();
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.key.startsWith(prefix) &&
            (!isDeliveryPlan(entry.value) ||
              entry.value.queueStateDir === ctx.deliveryQueueStateDir),
        )
        .map(async (entry) => await store.delete(entry.key)),
    );
  } catch (error) {
    invalidateMatrixDeliveryPlanGarbageCollection();
    throw error;
  }
}

export async function cleanupMatrixDeliveryPlanAfterCommit(ctx: {
  deliveryQueueId?: string;
  deliveryPayloadIndex?: number;
}): Promise<void> {
  if (ctx.deliveryQueueId === undefined || ctx.deliveryPayloadIndex === undefined) {
    return;
  }
  try {
    await deleteMatrixDeliveryPlansForPayload({
      queueId: ctx.deliveryQueueId,
      payloadIndex: ctx.deliveryPayloadIndex,
    });
  } catch (error) {
    // Core has already acked the queue row. Cleanup is best-effort here; the
    // re-armed startup sweep owns retry and must not downgrade a committed send.
    try {
      getMatrixRuntime()
        .logging.getChildLogger({ module: "matrix-durable-delivery" })
        .warn(`matrix: post-commit delivery plan cleanup failed (${String(error)})`);
    } catch {
      // Logging failure cannot change a committed delivery terminal either.
    }
  }
}

async function requireMatrixTransactionScopeId(client: MatrixClient): Promise<string> {
  const transactionScopeId = (await client.getTransactionScopeId()).trim();
  if (!transactionScopeId) {
    throw new MatrixDeliveryPlanInvariantError(
      "Matrix durable delivery requires a stable transaction scope",
    );
  }
  return transactionScopeId;
}

async function loadQueuePlans(queueId: string): Promise<MatrixDeliveryPlan[]> {
  const prefix = queuePrefix(queueId);
  const entries = await createDeliveryPlanStore().entries();
  return entries
    .filter((entry) => entry.key.startsWith(prefix) && entry.key.endsWith(".plan"))
    .map((entry) => {
      if (!isDeliveryPlan(entry.value)) {
        throw new MatrixDeliveryPlanInvariantError("Matrix durable delivery plan is invalid");
      }
      return entry.value;
    });
}

export async function reconcileMatrixUnknownSend(
  ctx: ChannelMessageUnknownSendContext,
): Promise<ChannelMessageUnknownSendReconciliationResult> {
  try {
    const plans = await loadQueuePlans(ctx.queueId);
    if (plans.length === 0) {
      if (ctx.durableDeliveryProtocol !== MATRIX_DURABLE_DELIVERY_PROTOCOL) {
        return {
          status: "unresolved",
          error: "Matrix queued delivery predates durable transaction plans",
          retryable: false,
        };
      }
      // Reconciliation only runs for a still-pending row, which GC always retains.
      // This protocol registers a plan before the first timeline PUT or throws.
      return { status: "not_sent" };
    }
    return await withResolvedMatrixSendClient(
      {
        cfg: ctx.cfg,
        accountId: ctx.accountId,
      },
      async (client) => {
        const transactionScopeId = await requireMatrixTransactionScopeId(client);
        const roomId = await resolveMatrixRoomId(client, ctx.to);
        const wireEventType = await client.getMessageWireEventType(roomId);
        const payloadIndexes = new Set(
          ctx.payloadSourceIndexes ?? ctx.payloads.map((_, index) => index),
        );
        for (const plan of plans) {
          if (plan.queueId !== ctx.queueId || plan.accountId !== (ctx.accountId ?? "")) {
            throw new MatrixDeliveryPlanInvariantError(
              "Matrix durable delivery plan identity no longer matches the queued delivery",
            );
          }
          if (!payloadIndexes.has(plan.payloadIndex)) {
            // Core may have committed and compacted an earlier payload before a
            // post-commit plan deletion failed. It cannot be replayed from this row.
            await createDeliveryPlanStore().delete(
              planHeaderKey({
                queueId: plan.queueId,
                payloadIndex: plan.payloadIndex,
                partIndex: plan.partIndex,
              }),
            );
            continue;
          }
          if (plan.roomId !== roomId) {
            if (plan.dispatchStarted) {
              throw new MatrixDeliveryPlanInvariantError(
                "Matrix durable delivery room changed after timeline dispatch",
              );
            }
            await createDeliveryPlanStore().delete(
              planHeaderKey({
                queueId: plan.queueId,
                payloadIndex: plan.payloadIndex,
                partIndex: plan.partIndex,
              }),
            );
            continue;
          }
          if (plan.transactionScopeId !== transactionScopeId) {
            if (plan.dispatchStarted) {
              throw new MatrixDeliveryPlanInvariantError(
                "Matrix durable delivery transaction scope changed after timeline dispatch",
              );
            }
            await createDeliveryPlanStore().delete(
              planHeaderKey({
                queueId: plan.queueId,
                payloadIndex: plan.payloadIndex,
                partIndex: plan.partIndex,
              }),
            );
            continue;
          }
          if (plan.wireEventType !== wireEventType) {
            if (plan.dispatchStarted) {
              throw new MatrixDeliveryPlanInvariantError(
                "Matrix durable delivery plan endpoint changed after timeline dispatch",
              );
            }
            await createDeliveryPlanStore().delete(
              planHeaderKey({
                queueId: plan.queueId,
                payloadIndex: plan.payloadIndex,
                partIndex: plan.partIndex,
              }),
            );
          }
        }
        return { status: "replay_safe" };
      },
    );
  } catch (error) {
    return {
      status: "unresolved",
      error: error instanceof Error ? error.message : String(error),
      // Stored-plan invariant failures cannot heal. Store, client, and room
      // resolution failures are operational and must remain queued for retry.
      retryable: !(error instanceof MatrixDeliveryPlanInvariantError),
    };
  }
}

export function resolveMatrixDurableDeliveryIdentity(params: {
  queueId?: string;
  payloadIndex?: number;
  partIndex?: number;
}): MatrixDeliveryIdentity | null {
  if (params.queueId === undefined) {
    return null;
  }
  if (params.payloadIndex === undefined || params.partIndex === undefined) {
    throw new Error("Matrix durable delivery requires stable payload and part indexes");
  }
  return {
    queueId: params.queueId,
    payloadIndex: requireDeliveryIndex(params.payloadIndex, "payload index"),
    partIndex: requireDeliveryIndex(params.partIndex, "part index"),
  };
}

export async function resolveMatrixDurableDeliveryTransactionScopeId(
  client: MatrixClient,
): Promise<string> {
  return await requireMatrixTransactionScopeId(client);
}
