import { beforeEach, describe, expect, it, vi } from "vitest";
// Matrix durable delivery plan tests cover identity, persistence, reconciliation, and cleanup.
import type { PluginRuntime } from "../../runtime-api.js";
import { setMatrixRuntime } from "../runtime.js";
import { MATRIX_DURABLE_DELIVERY_PROTOCOL } from "./durable-delivery.js";

const withResolvedMatrixSendClientMock = vi.hoisted(() => vi.fn());
const resolveMatrixRoomIdMock = vi.hoisted(() => vi.fn());

vi.mock("./send/client.js", () => ({
  withResolvedMatrixSendClient: withResolvedMatrixSendClientMock,
}));

vi.mock("./send/targets.js", () => ({
  resolveMatrixRoomId: resolveMatrixRoomIdMock,
}));

import {
  cleanupMatrixDeliveryPlanAfterCommit,
  cleanupMatrixDeliveryPlansAfterTerminalFailure,
  createMatrixDeliveryTransactionId,
  loadMatrixDeliveryPlan as loadMatrixDeliveryPlanImpl,
  markMatrixDeliveryPlanDispatchStarted,
  persistMatrixDeliveryPlan as persistMatrixDeliveryPlanImpl,
  pruneMatrixTerminalDeliveryPlans,
  reconcileMatrixUnknownSend,
  resetMatrixDeliveryPlanAfterRejectedDispatch,
  resolveMatrixDeliveryPlanDispatchState,
} from "./delivery-plan.js";

type LoadPlanParams = Parameters<typeof loadMatrixDeliveryPlanImpl>[0];
type PersistPlanParams = Parameters<typeof persistMatrixDeliveryPlanImpl>[0];
const loadMatrixDeliveryPlan = (
  params: Omit<LoadPlanParams, "wireEventType"> & {
    wireEventType?: LoadPlanParams["wireEventType"];
  },
) =>
  loadMatrixDeliveryPlanImpl({
    ...params,
    wireEventType: params.wireEventType ?? "m.room.message",
  });
const persistMatrixDeliveryPlan = (
  params: Omit<PersistPlanParams, "wireEventType"> & {
    wireEventType?: PersistPlanParams["wireEventType"];
  },
) =>
  persistMatrixDeliveryPlanImpl({
    ...params,
    wireEventType: params.wireEventType ?? "m.room.message",
  });

type StoredEntry = { value: unknown; createdAt: number; expiresAt?: number };
const records = new Map<string, StoredEntry>();

const store = {
  register: vi.fn(async (key: string, value: unknown) => {
    records.set(key, { value: structuredClone(value), createdAt: Date.now() });
  }),
  registerIfAbsent: vi.fn(async (key: string, value: unknown) => {
    if (records.has(key)) {
      return false;
    }
    records.set(key, { value: structuredClone(value), createdAt: Date.now() });
    return true;
  }),
  lookup: vi.fn(async (key: string) => structuredClone(records.get(key)?.value)),
  consume: vi.fn(async (key: string) => {
    const value = records.get(key)?.value;
    records.delete(key);
    return structuredClone(value);
  }),
  delete: vi.fn(async (key: string) => records.delete(key)),
  entries: vi.fn(async () =>
    [...records.entries()].map(([key, entry]) => ({
      key,
      value: structuredClone(entry.value),
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    })),
  ),
  clear: vi.fn(async () => records.clear()),
};
const openKeyedStoreMock = vi.fn((_options: Record<string, unknown>) => store);
const getOutboundDeliveryQueueStatusMock = vi.fn<
  (queueId: string, stateDir?: string) => Promise<"pending" | "terminal" | "absent">
>(async () => "pending");
const logger = { warn: vi.fn() };

const runtimeStub = {
  logging: {
    getChildLogger: () => logger,
  },
  state: {
    getOutboundDeliveryQueueStatus: getOutboundDeliveryQueueStatusMock,
    openKeyedStore: openKeyedStoreMock,
  },
} as unknown as PluginRuntime;

const identity = { queueId: "queue-1", payloadIndex: 0, partIndex: 0 };
const client = {
  getTransactionScopeId: () => "SCOPE-1",
  getMessageWireEventType: async () => "m.room.message" as const,
};

describe("Matrix durable delivery plans", () => {
  beforeEach(() => {
    records.clear();
    vi.clearAllMocks();
    logger.warn.mockReset();
    getOutboundDeliveryQueueStatusMock.mockResolvedValue("pending");
    setMatrixRuntime(runtimeStub);
    withResolvedMatrixSendClientMock.mockImplementation(
      async (_opts: unknown, run: (resolved: typeof client) => Promise<unknown>) =>
        await run(client),
    );
    resolveMatrixRoomIdMock.mockResolvedValue("!room:example");
  });

  it("derives deterministic, part-scoped transaction ids", () => {
    const first = createMatrixDeliveryTransactionId(identity, 0);
    expect(createMatrixDeliveryTransactionId(identity, 0)).toBe(first);
    expect(createMatrixDeliveryTransactionId({ ...identity, payloadIndex: 1 }, 0)).not.toBe(first);
    expect(createMatrixDeliveryTransactionId({ ...identity, partIndex: 1 }, 0)).not.toBe(first);
    expect(
      createMatrixDeliveryTransactionId({ ...identity, queueStateDir: "/other-state" }, 0),
    ).not.toBe(first);
    expect(createMatrixDeliveryTransactionId(identity, 1)).not.toBe(first);
    expect(first).toMatch(/^oc_[A-Za-z0-9_-]{43}$/);
  });

  it("atomically persists a complete plan without expiry and loads the exact record", async () => {
    const registration = await persistMatrixDeliveryPlan({
      identity,
      accountId: "default",
      roomId: "!room:example",
      transactionScopeId: "SCOPE-1",
      events: [
        {
          receiptKind: "text",
          content: { msgtype: "m.text", body: "original" },
        },
        {
          receiptKind: "text",
          content: { msgtype: "m.text", body: "follow-up" },
        },
      ],
    });

    expect(store.register).not.toHaveBeenCalled();
    expect(store.registerIfAbsent).toHaveBeenCalledTimes(1);
    expect(store.registerIfAbsent.mock.calls[0]?.[0]).toMatch(/\.plan$/);
    expect(records.size).toBe(1);
    expect(openKeyedStoreMock.mock.calls[0]?.[0]).not.toHaveProperty("defaultTtlMs");
    expect(registration.created).toBe(true);
    expect(registration.plan.dispatchStarted).toBe(false);
    expect(registration.plan.events.map((event) => event.content.body)).toEqual([
      "original",
      "follow-up",
    ]);
    expect(registration.plan.queueId).toBe("queue-1");
    await expect(
      loadMatrixDeliveryPlan({
        identity,
        accountId: "default",
        roomId: "!room:example",
        transactionScopeId: "SCOPE-1",
      }),
    ).resolves.toEqual(registration.plan);
  });

  it("reports the authoritative durable dispatch state", async () => {
    await expect(resolveMatrixDeliveryPlanDispatchState(identity)).resolves.toBe("absent");
    await persistMatrixDeliveryPlan({
      identity,
      roomId: "!room:example",
      transactionScopeId: "SCOPE-1",
      events: [{ receiptKind: "text", content: { msgtype: "m.text", body: "hello" } }],
    });
    await expect(resolveMatrixDeliveryPlanDispatchState(identity)).resolves.toBe("not_started");

    await markMatrixDeliveryPlanDispatchStarted(identity);

    await expect(resolveMatrixDeliveryPlanDispatchState(identity)).resolves.toBe("started");

    await resetMatrixDeliveryPlanAfterRejectedDispatch(identity);

    await expect(resolveMatrixDeliveryPlanDispatchState(identity)).resolves.toBe("not_started");
  });

  it("keeps the first complete plan immutable when writers race with different content", async () => {
    const original = await persistMatrixDeliveryPlan({
      identity,
      roomId: "!room:example",
      transactionScopeId: "SCOPE-1",
      events: [{ receiptKind: "text", content: { msgtype: "m.text", body: "original" } }],
    });
    const losingWriter = await persistMatrixDeliveryPlan({
      identity,
      roomId: "!room:example",
      transactionScopeId: "SCOPE-1",
      events: [
        { receiptKind: "text", content: { msgtype: "m.text", body: "different" } },
        { receiptKind: "text", content: { msgtype: "m.text", body: "extra chunk" } },
      ],
    });

    expect(original.created).toBe(true);
    expect(losingWriter).toEqual({ plan: original.plan, created: false });
    expect(losingWriter.plan.events.map((event) => event.content.body)).toEqual(["original"]);
    expect(records.size).toBe(1);
  });

  it("isolates identical queue ids across queue state roots", async () => {
    const customIdentity = { ...identity, queueStateDir: "/custom-state" };
    const defaultPlan = await persistMatrixDeliveryPlan({
      identity,
      roomId: "!room:example",
      transactionScopeId: "SCOPE-1",
      events: [{ receiptKind: "text", content: { msgtype: "m.text", body: "default" } }],
    });
    const customPlan = await persistMatrixDeliveryPlan({
      identity: customIdentity,
      roomId: "!room:example",
      transactionScopeId: "SCOPE-1",
      events: [{ receiptKind: "text", content: { msgtype: "m.text", body: "custom" } }],
    });

    expect(records.size).toBe(2);
    expect(defaultPlan.plan.events[0]?.content.body).toBe("default");
    expect(customPlan.plan.events[0]?.content.body).toBe("custom");
    expect(customPlan.plan.events[0]?.transactionId).not.toBe(
      defaultPlan.plan.events[0]?.transactionId,
    );

    await cleanupMatrixDeliveryPlanAfterCommit({
      deliveryQueueId: customIdentity.queueId,
      deliveryQueueStateDir: customIdentity.queueStateDir,
      deliveryPayloadIndex: customIdentity.payloadIndex,
    });

    await expect(
      loadMatrixDeliveryPlan({
        identity,
        roomId: "!room:example",
        transactionScopeId: "SCOPE-1",
      }),
    ).resolves.toEqual(defaultPlan.plan);
    await expect(
      loadMatrixDeliveryPlan({
        identity: customIdentity,
        roomId: "!room:example",
        transactionScopeId: "SCOPE-1",
      }),
    ).resolves.toBeNull();
  });

  it("returns replay_safe only when every committed plan matches the active device and room", async () => {
    await persistMatrixDeliveryPlan({
      identity: { ...identity, queueStateDir: "/custom-state" },
      accountId: "default",
      roomId: "!room:example",
      transactionScopeId: "SCOPE-1",
      events: [{ receiptKind: "text", content: { msgtype: "m.text", body: "hello" } }],
    });

    const ctx = {
      cfg: {},
      queueId: "queue-1",
      deliveryQueueStateDir: "/custom-state",
      channel: "matrix",
      to: "room:!room:example",
      accountId: "default",
      enqueuedAt: 1,
      retryCount: 0,
      payloads: [{ text: "hello" }],
    };
    await expect(reconcileMatrixUnknownSend(ctx)).resolves.toEqual({ status: "replay_safe" });
    await markMatrixDeliveryPlanDispatchStarted({ ...identity, queueStateDir: "/custom-state" });

    const mismatchedClient = {
      getTransactionScopeId: () => "SCOPE-2",
      getMessageWireEventType: async () => "m.room.message" as const,
    };
    withResolvedMatrixSendClientMock.mockImplementationOnce(
      async (_opts: unknown, run: (resolved: typeof mismatchedClient) => Promise<unknown>) =>
        await run(mismatchedClient),
    );
    await expect(reconcileMatrixUnknownSend(ctx)).resolves.toMatchObject({
      status: "unresolved",
      retryable: false,
    });
  });

  it("rebuilds a never-dispatched plan after the Matrix transaction scope changes", async () => {
    await persistMatrixDeliveryPlan({
      identity,
      accountId: "default",
      roomId: "!room:example",
      transactionScopeId: "SCOPE-1",
      events: [{ receiptKind: "text", content: { msgtype: "m.text", body: "hello" } }],
    });
    const replacementClient = {
      getTransactionScopeId: () => "SCOPE-2",
      getMessageWireEventType: async () => "m.room.message" as const,
    };
    withResolvedMatrixSendClientMock.mockImplementationOnce(
      async (_opts: unknown, run: (resolved: typeof replacementClient) => Promise<unknown>) =>
        await run(replacementClient),
    );

    await expect(
      reconcileMatrixUnknownSend({
        cfg: {},
        queueId: "queue-1",
        channel: "matrix",
        to: "room:!room:example",
        accountId: "default",
        enqueuedAt: 1,
        retryCount: 0,
        payloads: [{ text: "hello" }],
      }),
    ).resolves.toEqual({ status: "replay_safe" });
    await expect(
      loadMatrixDeliveryPlan({
        identity,
        accountId: "default",
        roomId: "!room:example",
        transactionScopeId: "SCOPE-2",
      }),
    ).resolves.toBeNull();
  });

  it("keeps transient reconciliation failures queued for retry", async () => {
    await persistMatrixDeliveryPlan({
      identity,
      accountId: "default",
      roomId: "!room:example",
      transactionScopeId: "SCOPE-1",
      events: [{ receiptKind: "text", content: { msgtype: "m.text", body: "hello" } }],
    });
    resolveMatrixRoomIdMock.mockRejectedValueOnce(new Error("temporary homeserver failure"));

    await expect(
      reconcileMatrixUnknownSend({
        cfg: {},
        queueId: "queue-1",
        channel: "matrix",
        to: "room:!room:example",
        accountId: "default",
        enqueuedAt: 1,
        retryCount: 0,
        payloads: [{ text: "hello" }],
      }),
    ).resolves.toEqual({
      status: "unresolved",
      error: "temporary homeserver failure",
      retryable: true,
    });
  });

  it("rejects replay when the Matrix wire endpoint changed", async () => {
    await persistMatrixDeliveryPlan({
      identity,
      accountId: "default",
      roomId: "!room:example",
      transactionScopeId: "SCOPE-1",
      wireEventType: "m.room.message",
      events: [{ receiptKind: "text", content: { msgtype: "m.text", body: "hello" } }],
    });
    await markMatrixDeliveryPlanDispatchStarted(identity);
    const encryptedClient = {
      getTransactionScopeId: () => "SCOPE-1",
      getMessageWireEventType: async () => "m.room.encrypted" as const,
    };
    withResolvedMatrixSendClientMock.mockImplementationOnce(
      async (_opts: unknown, run: (resolved: typeof encryptedClient) => Promise<unknown>) =>
        await run(encryptedClient),
    );

    await expect(
      reconcileMatrixUnknownSend({
        cfg: {},
        queueId: "queue-1",
        channel: "matrix",
        to: "room:!room:example",
        accountId: "default",
        enqueuedAt: 1,
        retryCount: 0,
        payloads: [{ text: "hello" }],
      }),
    ).resolves.toMatchObject({ status: "unresolved", retryable: false });
  });

  it("discards an endpoint-bound plan that never reached timeline dispatch", async () => {
    await persistMatrixDeliveryPlan({
      identity,
      accountId: "default",
      roomId: "!room:example",
      transactionScopeId: "SCOPE-1",
      wireEventType: "m.room.message",
      events: [{ receiptKind: "text", content: { msgtype: "m.text", body: "hello" } }],
    });

    await expect(
      loadMatrixDeliveryPlan({
        identity,
        accountId: "default",
        roomId: "!room:example",
        transactionScopeId: "SCOPE-1",
        wireEventType: "m.room.encrypted",
      }),
    ).resolves.toBeNull();
    expect(records.size).toBe(0);
  });

  it("discards a never-dispatched plan when a room alias resolves to a new room", async () => {
    await persistMatrixDeliveryPlan({
      identity,
      accountId: "default",
      roomId: "!old:example",
      transactionScopeId: "SCOPE-1",
      events: [{ receiptKind: "text", content: { msgtype: "m.text", body: "hello" } }],
    });

    await expect(
      loadMatrixDeliveryPlan({
        identity,
        accountId: "default",
        roomId: "!new:example",
        transactionScopeId: "SCOPE-1",
      }),
    ).resolves.toBeNull();
    expect(records.size).toBe(0);
  });

  it("reconciles a never-dispatched plan after a room alias remap", async () => {
    await persistMatrixDeliveryPlan({
      identity,
      accountId: "default",
      roomId: "!room:example",
      transactionScopeId: "SCOPE-1",
      events: [{ receiptKind: "text", content: { msgtype: "m.text", body: "hello" } }],
    });
    resolveMatrixRoomIdMock.mockResolvedValueOnce("!new-room:example");

    await expect(
      reconcileMatrixUnknownSend({
        cfg: {},
        queueId: "queue-1",
        channel: "matrix",
        to: "room:#alias:example",
        accountId: "default",
        enqueuedAt: 1,
        retryCount: 0,
        payloads: [{ text: "hello" }],
      }),
    ).resolves.toEqual({ status: "replay_safe" });
    expect(records.size).toBe(0);
  });

  it("accepts a sparse original payload index retained after queue compaction", async () => {
    const sparseIdentity = { ...identity, payloadIndex: 1 };
    await persistMatrixDeliveryPlan({
      identity: sparseIdentity,
      accountId: "default",
      roomId: "!room:example",
      transactionScopeId: "SCOPE-1",
      events: [{ receiptKind: "text", content: { msgtype: "m.text", body: "second" } }],
    });

    await expect(
      reconcileMatrixUnknownSend({
        cfg: {},
        queueId: "queue-1",
        channel: "matrix",
        to: "room:!room:example",
        accountId: "default",
        enqueuedAt: 1,
        retryCount: 0,
        payloads: [{ text: "second" }],
        payloadSourceIndexes: [1],
      }),
    ).resolves.toEqual({ status: "replay_safe" });
  });

  it("discards stale plans for payloads already compacted from the queue row", async () => {
    for (const payloadIndex of [0, 1]) {
      await persistMatrixDeliveryPlan({
        identity: { ...identity, payloadIndex },
        accountId: "default",
        roomId: "!room:example",
        transactionScopeId: "SCOPE-1",
        events: [
          { receiptKind: "text", content: { msgtype: "m.text", body: `payload-${payloadIndex}` } },
        ],
      });
    }

    await expect(
      reconcileMatrixUnknownSend({
        cfg: {},
        queueId: "queue-1",
        channel: "matrix",
        to: "room:!room:example",
        accountId: "default",
        enqueuedAt: 1,
        retryCount: 0,
        payloads: [{ text: "second" }],
        payloadSourceIndexes: [1],
      }),
    ).resolves.toEqual({ status: "replay_safe" });

    await expect(
      loadMatrixDeliveryPlan({
        identity,
        accountId: "default",
        roomId: "!room:example",
        transactionScopeId: "SCOPE-1",
      }),
    ).resolves.toBeNull();
    await expect(
      loadMatrixDeliveryPlan({
        identity: { ...identity, payloadIndex: 1 },
        accountId: "default",
        roomId: "!room:example",
        transactionScopeId: "SCOPE-1",
      }),
    ).resolves.not.toBeNull();
  });

  it("treats an absent plan as not sent and removes only the committed payload plans", async () => {
    await expect(
      reconcileMatrixUnknownSend({
        cfg: {},
        queueId: "queue-1",
        channel: "matrix",
        to: "room:!room:example",
        enqueuedAt: 1,
        retryCount: 0,
        durableDeliveryProtocol: MATRIX_DURABLE_DELIVERY_PROTOCOL,
        payloads: [{ text: "hello" }],
      }),
    ).resolves.toEqual({ status: "not_sent" });

    for (const payloadIndex of [0, 1]) {
      await persistMatrixDeliveryPlan({
        identity: { ...identity, payloadIndex },
        roomId: "!room:example",
        transactionScopeId: "SCOPE-1",
        events: [{ receiptKind: "text", content: { msgtype: "m.text", body: "hello" } }],
      });
    }
    await cleanupMatrixDeliveryPlanAfterCommit({
      deliveryQueueId: "queue-1",
      deliveryPayloadIndex: 0,
    });

    await expect(
      loadMatrixDeliveryPlan({
        identity,
        roomId: "!room:example",
        transactionScopeId: "SCOPE-1",
      }),
    ).resolves.toBeNull();
    await expect(
      loadMatrixDeliveryPlan({
        identity: { ...identity, payloadIndex: 1 },
        roomId: "!room:example",
        transactionScopeId: "SCOPE-1",
      }),
    ).resolves.not.toBeNull();

    await cleanupMatrixDeliveryPlansAfterTerminalFailure({
      queueId: "queue-1",
    });
    await expect(
      loadMatrixDeliveryPlan({
        identity: { ...identity, payloadIndex: 1 },
        roomId: "!room:example",
        transactionScopeId: "SCOPE-1",
      }),
    ).resolves.toBeNull();
  });

  it("does not replay an ambiguous legacy row that has no durable plan", async () => {
    await expect(
      reconcileMatrixUnknownSend({
        cfg: {},
        queueId: "legacy-queue",
        channel: "matrix",
        to: "room:!room:example",
        enqueuedAt: 1,
        retryCount: 0,
        payloads: [{ text: "possibly delivered" }],
      }),
    ).resolves.toEqual({
      status: "unresolved",
      error: "Matrix queued delivery predates durable transaction plans",
      retryable: false,
    });
    expect(withResolvedMatrixSendClientMock).not.toHaveBeenCalled();
  });

  it("prunes terminal and absent queue plans while retaining active plans", async () => {
    for (const queueId of ["queue-pending", "queue-failed", "queue-acked"]) {
      await persistMatrixDeliveryPlan({
        identity: {
          queueId,
          ...(queueId === "queue-failed" ? { queueStateDir: "/custom-state" } : {}),
          payloadIndex: 0,
          partIndex: 0,
        },
        roomId: "!room:example",
        transactionScopeId: "SCOPE-1",
        events: [{ receiptKind: "text", content: { msgtype: "m.text", body: queueId } }],
      });
    }
    getOutboundDeliveryQueueStatusMock.mockImplementation(async (queueId) => {
      if (queueId === "queue-pending") {
        return "pending";
      }
      return queueId === "queue-failed" ? "terminal" : "absent";
    });

    await expect(pruneMatrixTerminalDeliveryPlans()).resolves.toEqual({
      deleted: 2,
      retained: 1,
      invalid: 0,
    });
    expect(records.size).toBe(1);
    expect(getOutboundDeliveryQueueStatusMock).toHaveBeenCalledWith(
      "queue-failed",
      "/custom-state",
    );
    await expect(
      loadMatrixDeliveryPlan({
        identity: { queueId: "queue-pending", payloadIndex: 0, partIndex: 0 },
        roomId: "!room:example",
        transactionScopeId: "SCOPE-1",
      }),
    ).resolves.not.toBeNull();
  });

  it("re-arms terminal plan pruning after a cleanup store failure", async () => {
    await persistMatrixDeliveryPlan({
      identity,
      roomId: "!room:example",
      transactionScopeId: "SCOPE-1",
      events: [{ receiptKind: "text", content: { msgtype: "m.text", body: "hello" } }],
    });
    store.delete.mockRejectedValueOnce(new Error("store busy"));

    await expect(
      cleanupMatrixDeliveryPlanAfterCommit({
        deliveryQueueId: "queue-1",
        deliveryPayloadIndex: 0,
      }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "matrix: post-commit delivery plan cleanup failed (Error: store busy)",
    );

    getOutboundDeliveryQueueStatusMock.mockResolvedValue("terminal");
    await persistMatrixDeliveryPlan({
      identity: { queueId: "queue-2", payloadIndex: 0, partIndex: 0 },
      roomId: "!room:example",
      transactionScopeId: "SCOPE-1",
      events: [{ receiptKind: "text", content: { msgtype: "m.text", body: "next" } }],
    });

    expect(getOutboundDeliveryQueueStatusMock).toHaveBeenCalledWith("queue-1", undefined);
    expect(
      [...records.values()].some(
        (entry) =>
          typeof entry.value === "object" &&
          entry.value !== null &&
          "queueId" in entry.value &&
          entry.value.queueId === "queue-1",
      ),
    ).toBe(false);
  });

  it("re-arms terminal plan pruning when terminal failure cleanup cannot enumerate entries", async () => {
    await persistMatrixDeliveryPlan({
      identity,
      roomId: "!room:example",
      transactionScopeId: "SCOPE-1",
      events: [{ receiptKind: "text", content: { msgtype: "m.text", body: "hello" } }],
    });
    store.entries.mockRejectedValueOnce(new Error("store busy"));

    await expect(
      cleanupMatrixDeliveryPlansAfterTerminalFailure({ queueId: "queue-1" }),
    ).rejects.toThrow("store busy");

    getOutboundDeliveryQueueStatusMock.mockResolvedValue("terminal");
    await persistMatrixDeliveryPlan({
      identity: { queueId: "queue-2", payloadIndex: 0, partIndex: 0 },
      roomId: "!room:example",
      transactionScopeId: "SCOPE-1",
      events: [{ receiptKind: "text", content: { msgtype: "m.text", body: "next" } }],
    });

    expect(getOutboundDeliveryQueueStatusMock).toHaveBeenCalledWith("queue-1", undefined);
    expect(
      [...records.values()].some(
        (entry) =>
          typeof entry.value === "object" &&
          entry.value !== null &&
          "queueId" in entry.value &&
          entry.value.queueId === "queue-1",
      ),
    ).toBe(false);
  });

  it("suppresses post-commit enumeration failures and re-arms terminal plan pruning", async () => {
    await persistMatrixDeliveryPlan({
      identity,
      roomId: "!room:example",
      transactionScopeId: "SCOPE-1",
      events: [{ receiptKind: "text", content: { msgtype: "m.text", body: "hello" } }],
    });
    store.entries.mockRejectedValueOnce(new Error("store busy"));

    await expect(
      cleanupMatrixDeliveryPlanAfterCommit({
        deliveryQueueId: "queue-1",
        deliveryPayloadIndex: 0,
      }),
    ).resolves.toBeUndefined();

    getOutboundDeliveryQueueStatusMock.mockResolvedValue("terminal");
    await persistMatrixDeliveryPlan({
      identity: { queueId: "queue-2", payloadIndex: 0, partIndex: 0 },
      roomId: "!room:example",
      transactionScopeId: "SCOPE-1",
      events: [{ receiptKind: "text", content: { msgtype: "m.text", body: "next" } }],
    });

    expect(getOutboundDeliveryQueueStatusMock).toHaveBeenCalledWith("queue-1", undefined);
    expect(
      [...records.values()].some(
        (entry) =>
          typeof entry.value === "object" &&
          entry.value !== null &&
          "queueId" in entry.value &&
          entry.value.queueId === "queue-1",
      ),
    ).toBe(false);
  });
});
