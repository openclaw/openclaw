// Microsoft Graph Mail Wake tests cover HTTP handler behavior.
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import type { PluginLogger } from "../api.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { createGraphWakeDedupe, type GraphWakeDedupe } from "./dedupe.js";
import { createGraphWakeRequestHandler } from "./handler.js";
import type { GraphLifecycleEvent } from "./notifications.js";
import type { GraphLifecycleHandlingResult, GraphWakeSubscriptionRecord } from "./subscriptions.js";
import type { GraphWakePoster } from "./wake.js";

const ROUTE_PATH = "/plugins/msgraph-mail-wake";

type MockIncomingMessage = IncomingMessage & {
  destroyed?: boolean;
  destroy: () => MockIncomingMessage;
  socket: { remoteAddress: string };
};

function createRequest(params: {
  url: string;
  body?: unknown;
  method?: string;
}): MockIncomingMessage {
  const req = new EventEmitter() as MockIncomingMessage;
  req.method = params.method ?? "POST";
  req.url = params.url;
  req.headers = { "content-type": "application/json" };
  req.socket = { remoteAddress: "127.0.0.1" } as MockIncomingMessage["socket"];
  req.destroyed = false;
  req.destroy = (() => {
    req.destroyed = true;
    return req;
  }) as MockIncomingMessage["destroy"];

  setImmediate(() => {
    if (params.body !== undefined) {
      req.emit("data", Buffer.from(JSON.stringify(params.body), "utf8"));
    }
    req.emit("end");
  });
  return req;
}

function createRecord(
  overrides?: Partial<GraphWakeSubscriptionRecord>,
): GraphWakeSubscriptionRecord {
  return {
    mailboxId: "main",
    user: "ops@example.com",
    resource: "users/ops%40example.com/messages",
    changeType: "created",
    notificationUrl: "https://gateway.example.com/plugins/msgraph-mail-wake",
    fetchMessage: true,
    wake: { sessionKey: "agent:main:main", deliveryMode: "none" },
    subscriptionId: "sub-1",
    clientState: "client-secret-1",
    expirationDateTime: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function createNotification(overrides?: Record<string, unknown>) {
  return {
    subscriptionId: "sub-1",
    clientState: "client-secret-1",
    changeType: "created",
    resource: "users/ops@example.com/messages/AAMk123",
    ...overrides,
  };
}

function createHandler(options?: {
  record?: GraphWakeSubscriptionRecord;
  poster?: GraphWakePoster;
  onLifecycleEvent?: (params: {
    record: GraphWakeSubscriptionRecord;
    lifecycleEvent: GraphLifecycleEvent;
  }) => Promise<GraphLifecycleHandlingResult>;
  lookupSubscription?: (subscriptionId: string) => GraphWakeSubscriptionRecord | undefined;
  dedupe?: GraphWakeDedupe;
  logger?: PluginLogger;
}) {
  const record = options?.record ?? createRecord();
  const poster: GraphWakePoster = options?.poster ?? {
    postWake: vi.fn(
      async (): Promise<{ accepted: boolean; wakeId: string }> => ({
        accepted: true,
        wakeId: "wake-1",
      }),
    ),
    postResyncWake: vi.fn(
      async (): Promise<{ accepted: boolean; wakeId: string }> => ({
        accepted: true,
        wakeId: "wake-resync",
      }),
    ),
  };
  const onLifecycleEvent =
    options?.onLifecycleEvent ??
    vi.fn(
      async (): Promise<GraphLifecycleHandlingResult> => ({
        ok: true,
        action: "ignored",
      }),
    );
  const handler = createGraphWakeRequestHandler({
    cfg: {} as OpenClawConfig,
    path: ROUTE_PATH,
    ...(options?.dedupe ? { dedupe: options.dedupe } : {}),
    lookupSubscription:
      options?.lookupSubscription ??
      ((subscriptionId) => (subscriptionId === record.subscriptionId ? record : undefined)),
    poster,
    onLifecycleEvent,
    ...(options?.logger ? { logger: options.logger } : {}),
  });
  return { handler, poster, onLifecycleEvent, record };
}

async function invoke(
  handler: ReturnType<typeof createGraphWakeRequestHandler>,
  req: MockIncomingMessage,
) {
  const res = createMockServerResponse();
  const handled = await handler(req, res);
  return { res, handled };
}

describe("createGraphWakeRequestHandler", () => {
  it("answers the Graph validation handshake with a text/plain echo", async () => {
    const { handler } = createHandler();
    const { res, handled } = await invoke(
      handler,
      createRequest({ url: `${ROUTE_PATH}?validationToken=token-abc-123` }),
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.getHeader("content-type")).toContain("text/plain");
    expect(res.body).toBe("token-abc-123");
  });

  it("rejects non-POST methods", async () => {
    const { handler } = createHandler();
    const { res } = await invoke(handler, createRequest({ url: ROUTE_PATH, method: "GET" }));
    expect(res.statusCode).toBe(405);
  });

  it("acks malformed notification bodies as blocked with 202", async () => {
    const { handler } = createHandler();
    const { res } = await invoke(handler, createRequest({ url: ROUTE_PATH, body: { value: [] } }));
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body ?? "{}") as {
      ok: boolean;
      results: { status: string; reason: string }[];
    };
    expect(body.ok).toBe(false);
    expect(body.results[0]).toEqual({ status: "blocked", reason: "invalid_graph_notification" });
  });

  it("blocks notifications for unknown subscriptions without waking", async () => {
    const { handler, poster } = createHandler();
    const { res } = await invoke(
      handler,
      createRequest({
        url: ROUTE_PATH,
        body: { value: [createNotification({ subscriptionId: "sub-unknown" })] },
      }),
    );
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body ?? "{}") as {
      ok: boolean;
      results: { status: string; reason: string }[];
    };
    expect(body.ok).toBe(false);
    expect(body.results[0]).toEqual({ status: "blocked", reason: "unknown_subscription" });
    expect(poster.postWake).not.toHaveBeenCalled();
  });

  it("blocks clientState mismatches without waking, including padded secrets", async () => {
    const { handler, poster } = createHandler();
    for (const clientState of ["wrong", "client-secret-1 ", " client-secret-1"]) {
      const { res } = await invoke(
        handler,
        createRequest({ url: ROUTE_PATH, body: { value: [createNotification({ clientState })] } }),
      );
      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.body ?? "{}") as {
        results: { status: string; reason: string }[];
      };
      expect(body.results[0]).toEqual({ status: "blocked", reason: "client_state_mismatch" });
    }
    expect(poster.postWake).not.toHaveBeenCalled();
  });

  it("blocks resources outside the subscribed collection", async () => {
    const { handler, poster } = createHandler({
      record: createRecord({ resource: "users/ops%40example.com/mailFolders('inbox')/messages" }),
    });
    const { res } = await invoke(
      handler,
      createRequest({
        url: ROUTE_PATH,
        body: {
          value: [
            createNotification({
              resource: "users/ops@example.com/mailFolders('sent')/messages/AAMk1",
            }),
          ],
        },
      }),
    );
    const body = JSON.parse(res.body ?? "{}") as { results: { status: string; reason: string }[] };
    expect(body.results[0]).toEqual({
      status: "blocked",
      reason: "notification_resource_not_approved",
    });
    expect(poster.postWake).not.toHaveBeenCalled();
  });

  it("blocks non-mailbox resources", async () => {
    const { handler, poster } = createHandler();
    const { res } = await invoke(
      handler,
      createRequest({
        url: ROUTE_PATH,
        body: { value: [createNotification({ resource: "users/u/calendar/events/1" })] },
      }),
    );
    const body = JSON.parse(res.body ?? "{}") as { results: { status: string; reason: string }[] };
    expect(body.results[0]).toEqual({
      status: "blocked",
      reason: "notification_resource_not_approved",
    });
    expect(poster.postWake).not.toHaveBeenCalled();
  });

  it("blocks change types outside the subscribed membership", async () => {
    const { handler, poster } = createHandler();
    const { res } = await invoke(
      handler,
      createRequest({
        url: ROUTE_PATH,
        body: { value: [createNotification({ changeType: "updated" })] },
      }),
    );
    const body = JSON.parse(res.body ?? "{}") as { results: { status: string; reason: string }[] };
    expect(body.results[0]).toEqual({
      status: "blocked",
      reason: "notification_change_type_not_approved",
    });
    expect(poster.postWake).not.toHaveBeenCalled();
  });

  it("accepts change types in a multi-value subscription", async () => {
    const { handler, poster } = createHandler({
      record: createRecord({ changeType: "created,updated" }),
    });
    const { res } = await invoke(
      handler,
      createRequest({
        url: ROUTE_PATH,
        body: { value: [createNotification({ changeType: "updated" })] },
      }),
    );
    const body = JSON.parse(res.body ?? "{}") as { ok: boolean; results: { status: string }[] };
    expect(body.ok).toBe(true);
    expect(body.results[0]?.status).toBe("wake_scheduled");
    expect(poster.postWake).toHaveBeenCalledTimes(1);
  });

  it("schedules a wake for a valid notification", async () => {
    const { handler, poster, record } = createHandler();
    const { res } = await invoke(
      handler,
      createRequest({ url: ROUTE_PATH, body: { value: [createNotification()] } }),
    );
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body ?? "{}") as {
      ok: boolean;
      results: { status: string; wakeId?: string; idempotencyKey?: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.results[0]?.status).toBe("wake_scheduled");
    expect(body.results[0]?.wakeId).toBe("wake-1");
    expect(poster.postWake).toHaveBeenCalledTimes(1);
    expect(poster.postWake).toHaveBeenCalledWith(
      expect.objectContaining({
        record,
        messageId: "AAMk123",
        idempotencyKey: body.results[0]?.idempotencyKey,
      }),
    );
  });

  it("dedupes redeliveries of the same notification within the TTL", async () => {
    const { handler, poster } = createHandler();
    const first = await invoke(
      handler,
      createRequest({ url: ROUTE_PATH, body: { value: [createNotification()] } }),
    );
    expect(JSON.parse(first.res.body ?? "{}").results[0].status).toBe("wake_scheduled");

    const second = await invoke(
      handler,
      createRequest({ url: ROUTE_PATH, body: { value: [createNotification()] } }),
    );
    const body = JSON.parse(second.res.body ?? "{}") as {
      ok: boolean;
      results: { status: string; wakeId?: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.results[0]).toMatchObject({ status: "duplicate", wakeId: "wake-1" });
    expect(poster.postWake).toHaveBeenCalledTimes(1);
  });

  it("uses the top-level Graph notification id as the delivery identity", async () => {
    const { handler, poster } = createHandler();
    await invoke(
      handler,
      createRequest({
        url: ROUTE_PATH,
        body: { value: [createNotification({ id: "notification-1" })] },
      }),
    );

    const sameId = await invoke(
      handler,
      createRequest({
        url: ROUTE_PATH,
        body: {
          value: [
            createNotification({
              id: "notification-1",
              resource: "users/ops@example.com/messages/AAMk456",
            }),
          ],
        },
      }),
    );
    expect(JSON.parse(sameId.res.body ?? "{}").results[0].status).toBe("duplicate");

    const differentId = await invoke(
      handler,
      createRequest({
        url: ROUTE_PATH,
        body: { value: [createNotification({ id: "notification-2" })] },
      }),
    );
    expect(JSON.parse(differentId.res.body ?? "{}").results[0].status).toBe("wake_scheduled");
    expect(poster.postWake).toHaveBeenCalledTimes(2);
  });

  it("falls back to resource identity even when optional resourceData varies", async () => {
    const { handler, poster } = createHandler();
    await invoke(
      handler,
      createRequest({
        url: ROUTE_PATH,
        body: {
          value: [createNotification({ resourceData: { id: "resource-data-version-1" } })],
        },
      }),
    );
    const second = await invoke(
      handler,
      createRequest({
        url: ROUTE_PATH,
        body: {
          value: [createNotification({ resourceData: { id: "resource-data-version-2" } })],
        },
      }),
    );

    expect(JSON.parse(second.res.body ?? "{}").results[0].status).toBe("duplicate");
    expect(poster.postWake).toHaveBeenCalledTimes(1);
  });

  it("wakes again for the same message after the dedup TTL expires", async () => {
    let nowMs = 1_000_000;
    const dedupe = createGraphWakeDedupe({ now: () => nowMs, ttlMs: 60_000 });
    const { handler, poster } = createHandler({ dedupe });

    await invoke(
      handler,
      createRequest({ url: ROUTE_PATH, body: { value: [createNotification()] } }),
    );
    nowMs += 61_000;
    const second = await invoke(
      handler,
      createRequest({ url: ROUTE_PATH, body: { value: [createNotification()] } }),
    );
    expect(JSON.parse(second.res.body ?? "{}").results[0].status).toBe("wake_scheduled");
    expect(poster.postWake).toHaveBeenCalledTimes(2);
  });

  it("shares the leader wake with concurrent followers of the same notification", async () => {
    let release: ((value: { accepted: boolean; wakeId: string }) => void) | undefined;
    const poster: GraphWakePoster = {
      postWake: vi.fn(
        () =>
          new Promise<{ accepted: boolean; wakeId: string }>((resolve) => {
            release = resolve;
          }),
      ),
      postResyncWake: vi.fn(async () => ({ accepted: true, wakeId: "wake-resync" })),
    };
    // Observe the shared-claim branch deterministically: the follower must
    // claim while the leader is still in flight.
    const dedupe = createGraphWakeDedupe();
    let sawSharedClaim = false;
    const spyDedupe: GraphWakeDedupe = {
      claim: (key) => {
        const claim = dedupe.claim(key);
        if (claim.kind === "shared") {
          sawSharedClaim = true;
        }
        return claim;
      },
    };
    const { handler } = createHandler({ poster, dedupe: spyDedupe });

    const first = invoke(
      handler,
      createRequest({ url: ROUTE_PATH, body: { value: [createNotification()] } }),
    );
    await vi.waitFor(() => {
      expect(poster.postWake).toHaveBeenCalledTimes(1);
    });
    const second = invoke(
      handler,
      createRequest({ url: ROUTE_PATH, body: { value: [createNotification()] } }),
    );
    await vi.waitFor(() => {
      expect(sawSharedClaim).toBe(true);
    });

    release?.({ accepted: true, wakeId: "wake-1" });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(JSON.parse(firstResult.res.body ?? "{}").results[0].status).toBe("wake_scheduled");
    const secondBody = JSON.parse(secondResult.res.body ?? "{}") as {
      results: { status: string; wakeId?: string }[];
    };
    expect(secondBody.results[0]).toMatchObject({ status: "coalesced", wakeId: "wake-1" });
    expect(poster.postWake).toHaveBeenCalledTimes(1);
  });

  it("acks lifecycle events and notifies the subscription manager", async () => {
    const onLifecycleEvent = vi.fn(async () => ({
      ok: true as const,
      action: "recreated" as const,
    }));
    const { handler } = createHandler({ onLifecycleEvent });
    const { res } = await invoke(
      handler,
      createRequest({
        url: ROUTE_PATH,
        body: {
          value: [
            {
              subscriptionId: "sub-1",
              clientState: "client-secret-1",
              lifecycleEvent: "subscriptionRemoved",
            },
          ],
        },
      }),
    );
    const body = JSON.parse(res.body ?? "{}") as {
      ok: boolean;
      results: { status: string; lifecycleEvent?: string; action?: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.results[0]).toEqual({
      status: "lifecycle_ack",
      lifecycleEvent: "subscriptionRemoved",
      action: "recreated",
    });
    expect(onLifecycleEvent).toHaveBeenCalledWith({
      record: expect.objectContaining({ subscriptionId: "sub-1" }),
      lifecycleEvent: "subscriptionRemoved",
    });
  });

  it("finishes a same-subscription change before replacement and dedupes a batch retry", async () => {
    const oldRecord = createRecord();
    const newRecord = createRecord({
      subscriptionId: "sub-2",
      clientState: "client-secret-2",
    });
    const records = new Map([[oldRecord.subscriptionId, oldRecord]]);
    let lifecycleAttempts = 0;
    let recreations = 0;
    const onLifecycleEvent = vi.fn(async (): Promise<GraphLifecycleHandlingResult> => {
      lifecycleAttempts += 1;
      if (lifecycleAttempts === 1) {
        return { ok: false, retryable: true, code: "subscription_create_failed" };
      }
      records.delete(oldRecord.subscriptionId);
      records.set(newRecord.subscriptionId, newRecord);
      recreations += 1;
      return { ok: true, action: "recreated" };
    });
    const { handler, poster } = createHandler({
      onLifecycleEvent,
      lookupSubscription: (subscriptionId) => records.get(subscriptionId),
    });
    const mixedBatch = {
      value: [
        {
          subscriptionId: oldRecord.subscriptionId,
          clientState: oldRecord.clientState,
          lifecycleEvent: "subscriptionRemoved",
        },
        createNotification({ id: "notification-mixed-1" }),
      ],
    };

    const first = await invoke(handler, createRequest({ url: ROUTE_PATH, body: mixedBatch }));
    expect(first.res.statusCode).toBe(500);
    expect(
      JSON.parse(first.res.body ?? "{}").results.map((result: { status: string }) => result.status),
    ).toEqual(["wake_scheduled", "blocked"]);

    const retry = await invoke(handler, createRequest({ url: ROUTE_PATH, body: mixedBatch }));
    expect(retry.res.statusCode).toBe(202);
    expect(
      JSON.parse(retry.res.body ?? "{}").results.map((result: { status: string }) => result.status),
    ).toEqual(["duplicate", "lifecycle_ack"]);
    expect(poster.postWake).toHaveBeenCalledTimes(1);
    expect(onLifecycleEvent).toHaveBeenCalledTimes(2);
    expect(recreations).toBe(1);
    expect(records.has(oldRecord.subscriptionId)).toBe(false);
    expect(records.get(newRecord.subscriptionId)).toBe(newRecord);
  });

  it("rejects unknown lifecycle values without logging or reflecting them", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as PluginLogger;
    const onLifecycleEvent = vi.fn();
    const { handler } = createHandler({ logger, onLifecycleEvent });
    const rawLifecycleEvent = "futureEventWithSensitiveText";
    const { res } = await invoke(
      handler,
      createRequest({
        url: ROUTE_PATH,
        body: {
          value: [
            {
              subscriptionId: "sub-1",
              clientState: "client-secret-1",
              lifecycleEvent: rawLifecycleEvent,
            },
          ],
        },
      }),
    );

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body ?? "{}").results).toEqual([
      { status: "blocked", reason: "invalid_graph_notification" },
    ]);
    expect(res.body).not.toContain(rawLifecycleEvent);
    expect(onLifecycleEvent).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns 500 when lifecycle handling fails so Graph can retry", async () => {
    const onLifecycleEvent = vi.fn(
      async (): Promise<GraphLifecycleHandlingResult> => ({
        ok: false,
        retryable: true,
        code: "resync_wake_failed",
      }),
    );
    const { handler } = createHandler({ onLifecycleEvent });
    const { res } = await invoke(
      handler,
      createRequest({
        url: ROUTE_PATH,
        body: {
          value: [
            {
              subscriptionId: "sub-1",
              clientState: "client-secret-1",
              lifecycleEvent: "missed",
            },
          ],
        },
      }),
    );
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body ?? "{}").results[0]).toEqual({
      status: "blocked",
      reason: "lifecycle_handling_failed",
      lifecycleEvent: "missed",
      hostStatus: "resync_wake_failed",
    });
  });

  it("verifies clientState on lifecycle events too", async () => {
    const onLifecycleEvent = vi.fn(async () => ({
      ok: true as const,
      action: "recreated" as const,
    }));
    const { handler } = createHandler({ onLifecycleEvent });
    const { res } = await invoke(
      handler,
      createRequest({
        url: ROUTE_PATH,
        body: {
          value: [{ subscriptionId: "sub-1", clientState: "wrong", lifecycleEvent: "missed" }],
        },
      }),
    );
    expect(JSON.parse(res.body ?? "{}").results[0]).toEqual({
      status: "blocked",
      reason: "client_state_mismatch",
    });
    expect(onLifecycleEvent).not.toHaveBeenCalled();
  });

  it("processes every notification in a batch", async () => {
    const { handler, poster } = createHandler();
    const { res } = await invoke(
      handler,
      createRequest({
        url: ROUTE_PATH,
        body: {
          value: [
            createNotification({ resource: "users/ops@example.com/messages/AAMk1" }),
            createNotification({ resource: "users/ops@example.com/messages/AAMk2" }),
          ],
        },
      }),
    );
    const body = JSON.parse(res.body ?? "{}") as { ok: boolean; results: { status: string }[] };
    expect(body.ok).toBe(true);
    expect(body.results.map((result) => result.status)).toEqual([
      "wake_scheduled",
      "wake_scheduled",
    ]);
    expect(poster.postWake).toHaveBeenCalledTimes(2);
  });

  it("rejects a malformed entry without suppressing valid batch siblings", async () => {
    const { handler, poster } = createHandler();
    const { res } = await invoke(
      handler,
      createRequest({
        url: ROUTE_PATH,
        body: {
          value: [
            createNotification({ resource: "users/ops@example.com/messages/AAMk1" }),
            { subscriptionId: "sub-1", clientState: "client-secret-1" },
            createNotification({ resource: "users/ops@example.com/messages/AAMk2" }),
          ],
        },
      }),
    );

    expect(res.statusCode).toBe(202);
    expect(
      JSON.parse(res.body ?? "{}").results.map((result: { status: string }) => result.status),
    ).toEqual(["blocked", "wake_scheduled", "wake_scheduled"]);
    expect(poster.postWake).toHaveBeenCalledTimes(2);
  });

  it("retries only unfinished batch work after successful siblings dedupe", async () => {
    let secondFailed = false;
    const poster: GraphWakePoster = {
      postWake: vi.fn(async ({ messageId }) => {
        if (messageId === "AAMk2" && !secondFailed) {
          secondFailed = true;
          return { accepted: false, status: "host_scheduler_rejected" };
        }
        return { accepted: true, wakeId: `wake-${messageId}` };
      }),
      postResyncWake: vi.fn(async () => ({ accepted: true, wakeId: "wake-resync" })),
    };
    const { handler } = createHandler({ poster });
    const body = {
      value: [
        createNotification({ resource: "users/ops@example.com/messages/AAMk1" }),
        createNotification({ resource: "users/ops@example.com/messages/AAMk2" }),
      ],
    };

    const first = await invoke(handler, createRequest({ url: ROUTE_PATH, body }));
    expect(first.res.statusCode).toBe(500);
    expect(
      JSON.parse(first.res.body ?? "{}").results.map((result: { status: string }) => result.status),
    ).toEqual(["wake_scheduled", "blocked"]);

    const retry = await invoke(handler, createRequest({ url: ROUTE_PATH, body }));
    expect(retry.res.statusCode).toBe(202);
    expect(
      JSON.parse(retry.res.body ?? "{}").results.map((result: { status: string }) => result.status),
    ).toEqual(["duplicate", "wake_scheduled"]);
    expect(poster.postWake).toHaveBeenCalledTimes(3);
  });

  it("answers 500 on transient wake failures so Graph redelivers, and records nothing", async () => {
    const poster: GraphWakePoster = {
      postWake: vi.fn(async () => ({ accepted: false, status: "host_scheduler_rejected" })),
      postResyncWake: vi.fn(async () => ({ accepted: true, wakeId: "wake-resync" })),
    };
    const { handler } = createHandler({ poster });
    const { res } = await invoke(
      handler,
      createRequest({ url: ROUTE_PATH, body: { value: [createNotification()] } }),
    );
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body ?? "{}") as {
      ok: boolean;
      results: { status: string; reason: string; hostStatus?: string }[];
    };
    expect(body.ok).toBe(false);
    expect(body.results[0]).toEqual({
      status: "blocked",
      reason: "host_poster_rejected",
      hostStatus: "host_scheduler_rejected",
      idempotencyKey: expect.any(String),
    });

    // The next delivery is a fresh leader, not a dedup hit.
    (poster.postWake as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      accepted: true,
      wakeId: "wake-2",
    });
    const retry = await invoke(
      handler,
      createRequest({ url: ROUTE_PATH, body: { value: [createNotification()] } }),
    );
    expect(JSON.parse(retry.res.body ?? "{}").results[0].status).toBe("wake_scheduled");
  });

  it("never logs raw subscription ids or mailbox identifiers", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as PluginLogger;
    const { handler } = createHandler({ logger });
    await invoke(
      handler,
      createRequest({ url: ROUTE_PATH, body: { value: [createNotification()] } }),
    );

    const logged = [
      ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ]
      .flat()
      .join("\n");
    expect(logged).not.toContain("sub-1");
    expect(logged).not.toContain("ops@example.com");
    expect(logged).not.toContain("client-secret-1");
  });
});
