// Microsoft Graph Mail Wake tests cover wake poster behavior.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, PluginLogger } from "../api.js";
import type { GraphClient } from "./graph-client.js";
import type { GraphChangeNotification } from "./notifications.js";
import type { GraphWakeSubscriptionRecord } from "./subscriptions.js";
import { createGraphWakePoster, GRAPH_MESSAGE_ENRICHMENT_BUDGET_MS } from "./wake.js";

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
    wake: { sessionKey: "agent:main:main", agentId: "main", deliveryMode: "none" },
    subscriptionId: "sub-1",
    clientState: "client-secret-1",
    expirationDateTime: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function createNotification(): GraphChangeNotification {
  return {
    subscriptionId: "sub-1",
    notificationId: "notification-1",
    clientState: "client-secret-1",
    changeType: "created",
    resource: "users/ops@example.com/messages/AAMk123",
  };
}

function createApi(
  scheduleSessionTurn: OpenClawPluginApi["session"]["workflow"]["scheduleSessionTurn"],
) {
  const api = {
    session: {
      workflow: {
        scheduleSessionTurn,
      },
    },
  } as unknown as OpenClawPluginApi;
  return api;
}

describe("createGraphWakePoster", () => {
  it("schedules an immediate one-shot session turn with the plugin tag", async () => {
    const scheduleSessionTurn = vi.fn(async () => ({ id: "job-1" }));
    const client: GraphClient = {
      createSubscription: vi.fn(),
      renewSubscription: vi.fn(),
      deleteSubscription: vi.fn(),
      fetchMessage: vi.fn(async () => ({
        id: "AAMk123",
        subject: "Quarterly report",
        receivedDateTime: "2026-07-17T10:00:00Z",
        internetMessageId: "<abc@example.com>",
      })),
    };
    const poster = createGraphWakePoster({
      api: createApi(scheduleSessionTurn as never),
      client,
    });

    const result = await poster.postWake({
      record: createRecord(),
      messageId: "AAMk123",
      notification: createNotification(),
      idempotencyKey: "key-1",
    });

    expect(result).toEqual({ accepted: true, wakeId: expect.any(String) });
    expect(scheduleSessionTurn).toHaveBeenCalledTimes(1);
    const call = (scheduleSessionTurn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(call).toMatchObject({
      sessionKey: "agent:main:main",
      agentId: "main",
      delayMs: 1,
      deleteAfterRun: true,
      deliveryMode: "none",
      tag: "msgraph-mail-wake",
    });
    expect(String(call.name)).toMatch(/^msgraph-mail-wake-[a-f0-9]{16}$/);

    const message = JSON.parse(String(call.message)) as Record<string, unknown>;
    expect(message.schemaVersion).toBe(1);
    expect(message.source).toBe("msgraph-mail-wake");
    expect(message.kind).toBe("message_notification");
    expect(message.mailbox).toBe("ops@example.com");
    expect(message.messageId).toBe("AAMk123");
    expect(message.message).toMatchObject({ subject: "Quarterly report" });
  });

  it("still wakes when message enrichment fails without leaking error details", async () => {
    const scheduleSessionTurn = vi.fn(async () => ({ id: "job-1" }));
    const sensitiveError =
      "Bearer token-raw https://graph.microsoft.com/users/ops@example.com/messages/AAMk123";
    const client: GraphClient = {
      createSubscription: vi.fn(),
      renewSubscription: vi.fn(),
      deleteSubscription: vi.fn(),
      fetchMessage: vi.fn(async () => {
        throw new Error(sensitiveError);
      }),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as PluginLogger;
    const poster = createGraphWakePoster({
      api: createApi(scheduleSessionTurn as never),
      client,
      logger,
    });

    const result = await poster.postWake({
      record: createRecord(),
      messageId: "AAMk123",
      notification: createNotification(),
      idempotencyKey: "key-1",
    });

    expect(result.accepted).toBe(true);
    const call = (scheduleSessionTurn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const message = JSON.parse(String(call.message)) as Record<string, unknown>;
    expect(message.message).toBeNull();
    const logs = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(logs).toContain("message_enrichment_failed");
    expect(logs).not.toContain(sensitiveError);
    expect(logs).not.toContain("token-raw");
    expect(logs).not.toContain("ops@example.com");
    expect(logs).not.toContain("AAMk123");
  });

  it("stops waiting for enrichment before Graph's webhook deadline", async () => {
    vi.useFakeTimers();
    try {
      const scheduleSessionTurn = vi.fn(async () => ({ id: "job-1" }));
      const client: GraphClient = {
        createSubscription: vi.fn(),
        renewSubscription: vi.fn(),
        deleteSubscription: vi.fn(),
        fetchMessage: vi.fn(() => new Promise(() => {})),
      };
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as unknown as PluginLogger;
      const poster = createGraphWakePoster({
        api: createApi(scheduleSessionTurn as never),
        client,
        logger,
      });

      const resultPromise = poster.postWake({
        record: createRecord(),
        messageId: "AAMk123",
        notification: createNotification(),
        idempotencyKey: "key-timeout",
      });
      expect(scheduleSessionTurn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(GRAPH_MESSAGE_ENRICHMENT_BUDGET_MS);
      await expect(resultPromise).resolves.toMatchObject({ accepted: true });
      expect(scheduleSessionTurn).toHaveBeenCalledTimes(1);
      const call = (scheduleSessionTurn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(JSON.parse(String(call.message)).message).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("message_enrichment_timed_out"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports rejection when the scheduler refuses or throws", async () => {
    const rejecting = createGraphWakePoster({
      api: createApi(vi.fn(async () => undefined) as never),
    });
    const rejected = await rejecting.postWake({
      record: createRecord({ fetchMessage: false }),
      messageId: "AAMk123",
      notification: createNotification(),
      idempotencyKey: "key-1",
    });
    expect(rejected).toEqual({ accepted: false, status: "host_scheduler_rejected" });

    const throwing = createGraphWakePoster({
      api: createApi(
        vi.fn(async () => {
          throw new Error("cron unavailable");
        }) as never,
      ),
    });
    const threw = await throwing.postWake({
      record: createRecord({ fetchMessage: false }),
      messageId: "AAMk123",
      notification: createNotification(),
      idempotencyKey: "key-2",
    });
    expect(threw).toEqual({ accepted: false, status: "host_scheduler_rejected" });
  });

  it("schedules a resynchronization wake without a message reference", async () => {
    const scheduleSessionTurn = vi.fn(async () => ({ id: "job-2" }));
    const poster = createGraphWakePoster({
      api: createApi(scheduleSessionTurn as never),
    });

    const result = await poster.postResyncWake({
      record: createRecord(),
      reason: "missed_notifications",
    });

    expect(result.accepted).toBe(true);
    const call = (scheduleSessionTurn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(call).toMatchObject({
      sessionKey: "agent:main:main",
      delayMs: 1,
      deleteAfterRun: true,
      tag: "msgraph-mail-wake",
    });
    expect(String(call.name)).toMatch(/^msgraph-mail-wake-resync-[a-f0-9]{16}$/);
    const message = JSON.parse(String(call.message)) as Record<string, unknown>;
    expect(message.schemaVersion).toBe(1);
    expect(message.kind).toBe("mailbox_resync");
    expect(message.resyncReason).toBe("missed_notifications");
    expect(message.messageId).toBeUndefined();
  });
});
