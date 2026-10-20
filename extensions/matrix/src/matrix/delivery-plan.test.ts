import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getMatrixRuntime } from "../runtime.js";
import { installMatrixTestRuntime, resetMatrixTestStores } from "../test-runtime.js";
import {
  cleanupMatrixDeliveryPlans,
  createMatrixPlannedEvents,
  loadMatrixDeliveryPlan,
  persistMatrixDeliveryPlan,
  reconcileMatrixUnknownSend,
  resolveMatrixDurableDeliveryIdentity,
} from "./delivery-plan.js";
function dispatch(roomId: string, transactionId: string, version = "v3") {
  return {
    roomId,
    eventType: "m.room.message" as const,
    transactionId,
    requestPath: `/_matrix/client/${version}/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${transactionId}`,
  };
}

const client = {
  getTransactionScopeId: vi.fn(async () => "scope-1"),
  getMessageWireEventType: vi.fn(async () => "m.room.message" as const),
  sendMessage: vi.fn(
    async (
      roomId: string,
      _content: unknown,
      transactionId?: string,
      beforeWireDispatch?: (wire: ReturnType<typeof dispatch>) => Promise<void>,
    ) => {
      const resolvedTransactionId = transactionId ?? "missing";
      await beforeWireDispatch?.(dispatch(roomId, resolvedTransactionId));
      return `$${resolvedTransactionId}`;
    },
  ),
};

vi.mock("./send/client.js", () => ({
  withResolvedMatrixSendClient: async (
    _opts: unknown,
    run: (resolved: typeof client) => Promise<unknown>,
  ) => await run(client),
}));

vi.mock("./send/targets.js", () => ({
  resolveMatrixRoomId: vi.fn(async () => "!room:example.org"),
}));

let stateDir = "";

function identity(queueId = "queue-1", partIndex = 0, partCount = 1) {
  const resolved = resolveMatrixDurableDeliveryIdentity({ queueId, partIndex, partCount });
  if (!resolved) {
    throw new Error("expected durable Matrix identity");
  }
  return resolved;
}

function events(deliveryIdentity = identity(), body = "durable hello") {
  return createMatrixPlannedEvents({
    identity: deliveryIdentity,
    events: [
      {
        receiptKind: "text",
        content: { msgtype: "m.text", body },
      },
    ],
  });
}

function planTarget(deliveryIdentity = identity()) {
  return {
    identity: deliveryIdentity,
    accountId: "default",
    roomId: "!room:example.org",
    transactionScopeId: "scope-1",
    wireEventType: "m.room.message" as const,
  };
}

function persistEvents(plannedEvents: ReturnType<typeof events>, target = planTarget()) {
  const transactionId = plannedEvents[0]!.transactionId;
  return persistMatrixDeliveryPlan({
    ...target,
    events: plannedEvents,
    dispatch: dispatch(target.roomId, transactionId),
  });
}

async function persist(
  params: {
    queueId?: string;
    partIndex?: number;
    partCount?: number;
    scope?: string;
    body?: string;
  } = {},
) {
  const deliveryIdentity = identity(params.queueId, params.partIndex, params.partCount);
  const plannedEvents = events(deliveryIdentity, params.body);
  return await persistEvents(plannedEvents, {
    ...planTarget(deliveryIdentity),
    transactionScopeId: params.scope ?? "scope-1",
  });
}

function reconciliationContext(queueId = "queue-1") {
  return {
    cfg: {},
    queueId,
    channel: "matrix",
    to: "room:!room:example.org",
    accountId: "default",
    enqueuedAt: 1,
    payloads: [{ text: "durable hello" }],
    retryCount: 0,
  } as const;
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-plan-"));
  installMatrixTestRuntime({ stateDir });
  client.getTransactionScopeId.mockReset().mockResolvedValue("scope-1");
  client.getMessageWireEventType.mockReset().mockResolvedValue("m.room.message");
  client.sendMessage.mockClear();
});

afterEach(async () => {
  await resetMatrixTestStores();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

it("persists one exact plan and rejects a different plan for the same queue part", async () => {
  const plan = await persist();
  const deliveryIdentity = identity();
  expect(plan.events[0]).toMatchObject({
    receiptKind: "text",
    content: { msgtype: "m.text", body: "durable hello" },
  });
  expect(plan.events[0]?.transactionId).toMatch(/^oc_/);
  await expect(loadMatrixDeliveryPlan(planTarget(deliveryIdentity))).resolves.toEqual(plan);

  const changedEvents = events(deliveryIdentity, "changed");
  await expect(persistEvents(changedEvents, planTarget(deliveryIdentity))).rejects.toThrow(
    "no longer matches the prepared event batch",
  );
});

it.each([{ queueId: "different-queue" }, { partIndex: 1 }])(
  "rejects a stored plan whose identity differs from its lookup key: %j",
  async (changedIdentity) => {
    const plan = await persist({ partCount: 2 });
    const store = getMatrixRuntime().state.openBlobStore<Record<string, never>>({
      namespace: "outbound-delivery-plans",
      maxEntries: 10_000,
      maxBytesPerEntry: 8 * 1024 * 1024,
      maxBytesPerNamespace: 256 * 1024 * 1024,
      overflowPolicy: "reject-new",
      defaultTtlMs: 24 * 60 * 60 * 1000,
    });
    await store.register(
      `${createHash("sha256").update(plan.queueId).digest("hex")}.0`,
      new TextEncoder().encode(JSON.stringify({ ...plan, ...changedIdentity })),
      {},
    );
    await expect(loadMatrixDeliveryPlan(planTarget(identity("queue-1", 0, 2)))).rejects.toThrow(
      "Matrix durable delivery plan",
    );
  },
);

it("fails closed when a persisted plan contains invalid UTF-8", async () => {
  const queueId = "queue-invalid-utf8";
  const deliveryIdentity = identity(queueId);
  const plan = await persist({ queueId });
  const json = JSON.stringify(plan);
  const markerOffset = json.indexOf("durable hello");
  if (markerOffset < 0) {
    throw new Error("expected test plan body marker");
  }
  const invalidByteOffset = markerOffset + "durable".length;
  const bytes = Buffer.concat([
    Buffer.from(json.slice(0, invalidByteOffset)),
    Buffer.from([0xff]),
    Buffer.from(json.slice(invalidByteOffset)),
  ]);

  const store = getMatrixRuntime().state.openBlobStore<Record<string, never>>({
    namespace: "outbound-delivery-plans",
    maxEntries: 10_000,
    maxBytesPerEntry: 8 * 1024 * 1024,
    maxBytesPerNamespace: 256 * 1024 * 1024,
    overflowPolicy: "reject-new",
    defaultTtlMs: 24 * 60 * 60 * 1000,
  });
  await store.register(`${createHash("sha256").update(queueId).digest("hex")}.0`, bytes, {});

  await expect(reconcileMatrixUnknownSend(reconciliationContext(queueId))).resolves.toMatchObject({
    status: "unresolved",
    retryable: false,
    error: expect.stringContaining("invalid JSON"),
  });
  expect(client.sendMessage).not.toHaveBeenCalled();
  await expect(loadMatrixDeliveryPlan(planTarget(deliveryIdentity))).resolves.toBeNull();
});

it("preserves the unknown-error fallback for non-error send failures", async () => {
  await persist();
  client.sendMessage.mockRejectedValueOnce({ code: "M_UNKNOWN" });

  await expect(reconcileMatrixUnknownSend(reconciliationContext())).resolves.toMatchObject({
    status: "unresolved",
    error: "unknown error",
    retryable: true,
  });
});

it.each([false, true])(
  "preserves ordered typed receipt parts and the final event identity (duplicate ID: %s)",
  async (duplicateId) => {
    const deliveryIdentity = identity("queue-multi-event");
    const relation = {
      rel_type: "m.thread" as const,
      event_id: "$thread",
      "m.in_reply_to": { event_id: "$reply" },
    };
    const plannedEvents = createMatrixPlannedEvents({
      identity: deliveryIdentity,
      events: [
        {
          receiptKind: "media",
          content: { msgtype: "m.image", body: "caption", "m.relates_to": relation },
        },
        {
          receiptKind: "text",
          content: { msgtype: "m.text", body: "follow-up", "m.relates_to": relation },
        },
      ],
    });
    await persistEvents(plannedEvents, planTarget(deliveryIdentity));
    client.sendMessage
      .mockResolvedValueOnce("$media-event")
      .mockResolvedValueOnce(duplicateId ? "$media-event" : "$text-event");
    const messageIds = duplicateId ? ["$media-event"] : ["$media-event", "$text-event"];

    await expect(
      reconcileMatrixUnknownSend({
        ...reconciliationContext("queue-multi-event"),
        effectiveReplyToId: "$reply",
        threadId: "$thread",
      }),
    ).resolves.toMatchObject({
      status: "sent",
      messageId: messageIds.at(-1),
      receipt: {
        primaryPlatformMessageId: "$media-event",
        platformMessageIds: messageIds,
        replyToId: "$reply",
        threadId: "$thread",
        parts: messageIds.map((platformMessageId, index) => ({
          platformMessageId,
          kind: index === 0 ? "media" : "text",
          index,
          replyToId: "$reply",
          threadId: "$thread",
        })),
      },
    });
  },
);

it("fails closed without provider I/O when any expected part plan is missing", async () => {
  const incompleteIdentity = identity("queue-incomplete", 0, 2);
  await persist({ queueId: "queue-incomplete", partIndex: 0, partCount: 2 });

  await expect(
    reconcileMatrixUnknownSend(reconciliationContext("queue-incomplete")),
  ).resolves.toMatchObject({
    status: "unresolved",
    retryable: false,
    error: expect.stringContaining("incomplete event plan"),
  });
  expect(client.sendMessage).not.toHaveBeenCalled();
  await expect(loadMatrixDeliveryPlan(planTarget(incompleteIdentity))).resolves.toBeNull();
});

it("fails closed when the SDK selects a different Matrix endpoint path", async () => {
  await persist({ queueId: "queue-route" });
  client.sendMessage.mockImplementationOnce(
    async (roomId, _content, transactionId, beforeWireDispatch) => {
      await beforeWireDispatch?.(dispatch(roomId, transactionId ?? "missing", "v4"));
      return "$must-not-send";
    },
  );

  await expect(
    reconcileMatrixUnknownSend(reconciliationContext("queue-route")),
  ).resolves.toMatchObject({
    status: "unresolved",
    retryable: false,
    error: expect.stringContaining("no longer matches the prepared event batch"),
  });
});

it.each(["scope-1", "old-scope"])(
  "reconciles 129 parts and cleans only their queue after a sent or terminal result (scope: %s)",
  async (scope) => {
    const partCount = 129;
    const plans: Array<Awaited<ReturnType<typeof persist>>> = [];
    // Storage order deliberately differs from the required numeric delivery order.
    for (let partIndex = partCount - 1; partIndex >= 0; partIndex -= 1) {
      plans.unshift(
        await persist({
          queueId: "queue-many",
          partIndex,
          partCount,
          scope,
          body: `part ${partIndex}`,
        }),
      );
    }
    await persist({ queueId: "queue-keep" });

    const result = await reconcileMatrixUnknownSend(reconciliationContext("queue-many"));
    if (scope === "scope-1") {
      const messageIds = plans.map((plan) => `$${plan.events[0]!.transactionId}`);
      expect(result).toMatchObject({
        status: "sent",
        messageId: messageIds.at(-1),
        receipt: {
          primaryPlatformMessageId: messageIds[0],
          platformMessageIds: messageIds,
          parts: messageIds.map((platformMessageId, index) => ({
            platformMessageId,
            kind: "text",
            index,
          })),
        },
      });
      expect(client.sendMessage.mock.calls.map((call) => call.slice(0, 3))).toEqual(
        plans.map((plan) => [plan.roomId, plan.events[0]!.content, plan.events[0]!.transactionId]),
      );
      await cleanupMatrixDeliveryPlans({ queueId: "queue-many" });
    } else {
      expect(result).toMatchObject({
        status: "unresolved",
        retryable: false,
        error: expect.stringContaining("no longer matches the active delivery target"),
      });
      expect(client.sendMessage).not.toHaveBeenCalled();
    }

    for (const plan of plans) {
      await expect(loadMatrixDeliveryPlan({ ...plan, identity: plan })).resolves.toBeNull();
    }
    await expect(
      loadMatrixDeliveryPlan(planTarget(identity("queue-keep"))),
    ).resolves.not.toBeNull();
  },
);

it.each([false, true])(
  "preserves blank queue handling with a populated store: %s",
  async (populated) => {
    if (populated) {
      await persist({ queueId: "queue-keep" });
      await expect(cleanupMatrixDeliveryPlans({ queueId: " " })).rejects.toThrow(
        "requires a queue id",
      );
    } else {
      await expect(cleanupMatrixDeliveryPlans({ queueId: " " })).resolves.toBeUndefined();
    }

    await expect(reconcileMatrixUnknownSend(reconciliationContext(" "))).resolves.toMatchObject({
      status: "unresolved",
      retryable: populated,
      error: expect.stringContaining(populated ? "requires a queue id" : "no persisted event plan"),
    });
    expect(client.sendMessage).not.toHaveBeenCalled();
    if (populated) {
      await expect(
        loadMatrixDeliveryPlan(planTarget(identity("queue-keep"))),
      ).resolves.not.toBeNull();
    }
  },
);
