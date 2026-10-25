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

const load = (deliveryIdentity = identity()) =>
  loadMatrixDeliveryPlan(planTarget(deliveryIdentity));

function receiptParts(messageIds: string[], kinds: string[], threaded = false) {
  return messageIds.map((platformMessageId, index) => ({
    platformMessageId,
    kind: kinds[index] ?? "text",
    index,
    ...(threaded ? { replyToId: "$reply", threadId: "$thread" } : {}),
  }));
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

async function replaceStoredPlan(queueId: string, bytes: Uint8Array) {
  const store = getMatrixRuntime().state.openBlobStore<Record<string, never>>({
    namespace: "outbound-delivery-plans",
    maxEntries: 10_000,
    maxBytesPerEntry: 8 * 1024 * 1024,
    maxBytesPerNamespace: 256 * 1024 * 1024,
    overflowPolicy: "reject-new",
    defaultTtlMs: 24 * 60 * 60 * 1000,
  });
  await store.register(`${createHash("sha256").update(queueId).digest("hex")}.0`, bytes, {});
}

function expectUnresolved(queueId: string, error: string, retryable = false) {
  return expect(reconcileMatrixUnknownSend(reconciliationContext(queueId))).resolves.toMatchObject({
    status: "unresolved",
    retryable,
    error: error === "unknown error" ? error : expect.stringContaining(error),
  });
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
  await expect(load(deliveryIdentity)).resolves.toEqual(plan);

  const changedEvents = events(deliveryIdentity, "changed");
  await expect(persistEvents(changedEvents, planTarget(deliveryIdentity))).rejects.toThrow(
    "no longer matches the prepared event batch",
  );
});

it.each([{ queueId: "different-queue" }, { partIndex: 1 }])(
  "rejects a stored plan whose identity differs from its lookup key: %j",
  async (changedIdentity) => {
    const plan = await persist({ partCount: 2 });
    await replaceStoredPlan(
      plan.queueId,
      new TextEncoder().encode(JSON.stringify({ ...plan, ...changedIdentity })),
    );
    await expect(load(identity("queue-1", 0, 2))).rejects.toThrow("Matrix durable delivery plan");
  },
);

it.each([
  ["invalid UTF-8", "invalid JSON", false],
  ["missing part", "incomplete event plan", false],
  ["changed endpoint", "no longer matches the prepared event batch", false],
  ["non-Error send", "unknown error", true],
] as const)("reconciles %s without unsafe replay", async (failure, error, retryable) => {
  const plan = await persist({ partCount: failure === "missing part" ? 2 : 1 });
  if (failure === "invalid UTF-8") {
    const bytes = Buffer.from(JSON.stringify(plan));
    const marker = bytes.indexOf("durable hello");
    expect(marker).toBeGreaterThanOrEqual(0);
    bytes[marker + "durable".length] = 0xff;
    await replaceStoredPlan(plan.queueId, bytes);
  } else if (failure === "changed endpoint") {
    client.sendMessage.mockImplementationOnce(async (room, _content, txn, beforeDispatch) => {
      await beforeDispatch?.(dispatch(room, txn ?? "missing", "v4"));
      return "$must-not-send";
    });
  } else if (failure === "non-Error send") {
    client.sendMessage.mockRejectedValueOnce({ code: "M_UNKNOWN" });
  }
  await expectUnresolved(plan.queueId, error, retryable);
  if (failure === "invalid UTF-8" || failure === "missing part") {
    expect(client.sendMessage).not.toHaveBeenCalled();
  }
  if (!retryable) {
    await expect(load(identity(plan.queueId, 0, plan.partCount))).resolves.toBeNull();
  }
});

it("deduplicates receipts while preserving media and thread identity", async () => {
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
  client.sendMessage.mockResolvedValueOnce("$media-event").mockResolvedValueOnce("$media-event");
  const messageIds = ["$media-event"];

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
      parts: receiptParts(messageIds, ["media", "text"], true),
    },
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
          parts: receiptParts(messageIds, []),
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
    await expect(load(identity("queue-keep"))).resolves.not.toBeNull();
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

    await expectUnresolved(
      " ",
      populated ? "requires a queue id" : "no persisted event plan",
      populated,
    );
    expect(client.sendMessage).not.toHaveBeenCalled();
    if (populated) {
      await expect(load(identity("queue-keep"))).resolves.not.toBeNull();
    }
  },
);
